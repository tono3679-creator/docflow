-- ログインのセッション・回数制限・デモの片付け・メンバーの追加・デモの複製
--
-- * app_auth.sessions：Cookie にはランダムな値、DB にはその SHA-256 だけを保存する
-- * app_auth.rate_limits：ログインの失敗・デモの作成の回数（総当たり・大量作成の対策）
-- * app_private.demo_cleanup()：期限切れのデモ組織と、その匿名の利用者を消す（毎日の定期処理）
-- * public.admin_add_member()：管理者がメンバーを追加する（パスワードはアプリで scrypt にしてから渡す）

create table app_auth.sessions (
  token_hash text primary key,
  user_id uuid not null references app_auth.users (id) on delete cascade,
  -- 複数の組織に所属しているとき、どの組織として操作するか
  organization_id uuid references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_idx on app_auth.sessions (user_id);
create index sessions_expires_idx on app_auth.sessions (expires_at);

create table app_auth.rate_limits (
  id bigint generated always as identity primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index rate_limits_bucket_idx on app_auth.rate_limits (bucket, created_at);
revoke all on app_auth.sessions, app_auth.rate_limits from public, anon, authenticated;

create or replace function app_private.demo_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_users uuid[];
  v_count integer;
begin
  select coalesce(array_agg(distinct m.user_id), '{}') into v_users
    from public.organization_members m join public.organizations o on o.id = m.organization_id
   where o.is_demo and o.demo_expires_at < now();
  delete from public.organizations o where o.is_demo and o.demo_expires_at < now();
  get diagnostics v_count = row_count;
  -- どの書類からも参照されなくなったファイル本体
  delete from app_private.file_blobs b
   where not exists (select 1 from public.documents d where d.storage_path = 'db:' || b.sha256 or d.preview_path = 'db:' || b.sha256)
     and b.created_at < now() - interval '1 hour';
  delete from app_auth.users u where u.id = any(v_users) and u.is_anonymous
    and not exists (select 1 from public.organization_members m where m.user_id = u.id);
  delete from app_auth.sessions where expires_at < now();
  delete from app_auth.rate_limits where created_at < now() - interval '1 day';
  return v_count;
end $$;
revoke all on function app_private.demo_cleanup() from public, anon, authenticated;

create or replace function public.admin_add_member(
  p_email text, p_display_name text, p_role public.org_role, p_password_hash text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_id uuid;
begin
  if v_org is null or public.current_org_role() is distinct from 'admin' then
    raise exception 'メンバーを追加できるのは管理者だけです' using errcode = '42501';
  end if;
  if (select o.is_demo from public.organizations o where o.id = v_org) then
    raise exception 'デモ環境ではメンバーを追加できません' using errcode = '42501';
  end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(p_email) > 200 then
    raise exception 'メールアドレスの形式が正しくありません' using errcode = '22023';
  end if;
  if exists (select 1 from app_auth.users u where lower(u.email) = lower(p_email)) then
    raise exception 'このメールアドレスは既に登録されています' using errcode = '23514';
  end if;
  if p_password_hash !~ '^scrypt\$' then
    raise exception 'パスワードの形式が正しくありません' using errcode = '22023';
  end if;
  insert into app_auth.users (email, encrypted_password) values (lower(p_email), p_password_hash) returning id into v_id;
  insert into public.profiles (id, display_name) values (v_id, p_display_name);
  insert into public.organization_members (organization_id, user_id, role) values (v_org, v_id, p_role);
  perform app_private.audit(v_org, 'member.add', 'profile', v_id, jsonb_build_object('role', p_role));
  return v_id;
end $$;
revoke all on function public.admin_add_member(text, text, public.org_role, text) from public, anon;
grant execute on function public.admin_add_member(text, text, public.org_role, text) to authenticated;


-- ---------------------------------------------------------------
-- 設定・メンバーの変更（管理者のみ。変更は操作の記録に残す）
-- ---------------------------------------------------------------
create or replace function public.update_org_settings(
  p_max_file_mb integer, p_max_pages integer, p_threshold numeric, p_staff_limit bigint, p_llm_enabled boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin']::public.org_role[]);
  v_before public.organization_settings;
begin
  select * into v_before from public.organization_settings s where s.organization_id = v_org for update;
  -- デモ環境（訪問者ごと）では外部の AI に送らない（誰でも管理者になれるため）
  if p_llm_enabled and (select o.is_demo from public.organizations o where o.id = v_org) then
    raise exception 'デモ環境では外部の AI を使えません' using errcode = '42501';
  end if;
  update public.organization_settings set
    max_file_mb = p_max_file_mb, max_pages = p_max_pages, confidence_threshold = p_threshold,
    staff_confirm_limit = p_staff_limit, llm_enabled = p_llm_enabled
   where organization_id = v_org;
  perform app_private.audit(v_org, 'settings.update', 'organization', v_org, jsonb_build_object(
    'before', jsonb_build_object('max_file_mb', v_before.max_file_mb, 'max_pages', v_before.max_pages,
                                 'confidence_threshold', v_before.confidence_threshold, 'staff_confirm_limit', v_before.staff_confirm_limit,
                                 'llm_enabled', v_before.llm_enabled),
    'after', jsonb_build_object('max_file_mb', p_max_file_mb, 'max_pages', p_max_pages, 'confidence_threshold', p_threshold,
                                'staff_confirm_limit', p_staff_limit, 'llm_enabled', p_llm_enabled)));
end $$;

create or replace function public.update_member(p_user uuid, p_role public.org_role, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin']::public.org_role[]);
  v_before public.organization_members;
begin
  if p_user = auth.uid() then
    raise exception '自分の役割・利用状態は変更できません' using errcode = '42501';
  end if;
  select * into v_before from public.organization_members m where m.organization_id = v_org and m.user_id = p_user for update;
  if not found then
    raise exception 'メンバーが見つかりません' using errcode = 'P0002';
  end if;
  update public.organization_members set role = p_role, is_active = p_active where organization_id = v_org and user_id = p_user;
  perform app_private.audit(v_org, 'member.update', 'profile', p_user, jsonb_build_object(
    'before', jsonb_build_object('role', v_before.role, 'active', v_before.is_active),
    'after', jsonb_build_object('role', p_role, 'active', p_active)));
end $$;

-- 有効な管理者が1人もいなくなる変更は断る（どの経路の変更でも）
create or replace function app_private.keep_one_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and old.is_active and not (new.role = 'admin' and new.is_active)
     and not exists (select 1 from public.organization_members m
                      where m.organization_id = old.organization_id and m.user_id <> old.user_id and m.role = 'admin' and m.is_active) then
    raise exception '管理者が1人もいなくなる変更はできません' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger members_keep_admin before update on public.organization_members
  for each row execute function app_private.keep_one_admin();

revoke all on function public.update_org_settings(integer, integer, numeric, bigint, boolean) from public, anon;
revoke all on function public.update_member(uuid, public.org_role, boolean) from public, anon;
grant execute on function public.update_org_settings(integer, integer, numeric, bigint, boolean) to authenticated;
grant execute on function public.update_member(uuid, public.org_role, boolean) to authenticated;
