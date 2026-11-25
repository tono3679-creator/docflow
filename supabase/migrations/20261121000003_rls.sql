-- 行レベルセキュリティ（RLS）と権限
--
-- * どの表も「自分の組織（current_org_id()）」の行しか見えない（別の会社のデータは読めない）
-- * 書類・項目・検証結果・履歴の表には、ログイン利用者の書き込み権限を付けない（書き込みは 20261121000002 の DB 関数だけ）
-- * 設定・メンバーを変えられるのは管理者だけ。操作の記録・AI の利用量を見られるのも管理者だけ
-- * ファイル本体（app_private.file_blobs）はログイン利用者からは読めない

alter table public.organizations enable row level security;
alter table public.organization_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;
alter table public.documents enable row level security;
alter table public.document_pages enable row level security;
alter table public.extraction_jobs enable row level security;
alter table public.extraction_results enable row level security;
alter table public.document_line_items enable row level security;
alter table public.document_fields enable row level security;
alter table public.validation_issues enable row level security;
alter table public.review_actions enable row level security;
alter table public.document_confirmations enable row level security;
alter table public.duplicate_candidates enable row level security;
alter table public.export_jobs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.ai_usage_logs enable row level security;

-- まず全部取り上げてから、必要なものだけ許可する（Supabase の既定の権限も外す）
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app_private from public, anon, authenticated;
revoke all on all tables in schema app_private from public, anon, authenticated;
revoke all on all tables in schema app_auth from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema app_private revoke all on functions from public;

grant usage on schema app_private to authenticated;

grant select on public.organizations, public.organization_settings, public.profiles, public.organization_members,
  public.documents, public.document_pages, public.extraction_jobs, public.extraction_results, public.document_line_items,
  public.document_fields, public.validation_issues, public.review_actions, public.document_confirmations,
  public.duplicate_candidates, public.export_jobs, public.audit_logs, public.ai_usage_logs
  to authenticated;

grant update (name) on public.organizations to authenticated;
grant update (display_name) on public.profiles to authenticated;
-- 設定・メンバーの変更は DB 関数（update_org_settings・update_member）だけが行う（デモでの AI 利用の禁止・自分の変更の禁止・記録を必ず通すため）

grant execute on function public.current_org_id(), public.current_org_role(),
  public.register_document(text, text, text, integer, text, text, text, integer, uuid),
  public.request_extraction(uuid, public.document_type),
  public.apply_review_changes(uuid, integer, jsonb),
  public.sync_validation(uuid, jsonb),
  public.confirm_document(uuid, integer),
  public.reopen_document(uuid, text),
  public.decide_duplicate(uuid, public.duplicate_status),
  public.set_document_excluded(uuid, boolean, text),
  public.delete_document(uuid),
  public.record_export(text, text, uuid[], integer)
  to authenticated;
grant execute on function app_private.touch_updated_at() to authenticated;

-- ---------------------------------------------------------------
-- ポリシー
-- ---------------------------------------------------------------
create policy organizations_read on public.organizations for select to authenticated
  using (id = (select public.current_org_id()));
create policy organizations_update on public.organizations for update to authenticated
  using (id = (select public.current_org_id()) and (select public.current_org_role()) = 'admin')
  with check (id = (select public.current_org_id()));

create policy settings_read on public.organization_settings for select to authenticated
  using (organization_id = (select public.current_org_id()));

create policy members_read on public.organization_members for select to authenticated
  using (organization_id = (select public.current_org_id()));

create policy profiles_read on public.profiles for select to authenticated
  using (exists (select 1 from public.organization_members m where m.user_id = profiles.id and m.organization_id = (select public.current_org_id())));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) or ((select public.current_org_role()) = 'admin'
         and exists (select 1 from public.organization_members m where m.user_id = profiles.id and m.organization_id = (select public.current_org_id()))));

-- 書類と関連の表：同じ組織の人は全員読める（書き込みは DB 関数だけ）
do $$
declare
  t text;
begin
  foreach t in array array['documents', 'document_pages', 'extraction_jobs', 'extraction_results', 'document_line_items',
                           'document_fields', 'validation_issues', 'review_actions', 'document_confirmations',
                           'duplicate_candidates', 'export_jobs'] loop
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (organization_id = (select public.current_org_id()))', t);
  end loop;
end $$;

-- 操作の記録：管理者は組織のすべて、ほかの人は書類に関するものだけ（書類の履歴の表示に使う）
create policy audit_logs_read on public.audit_logs for select to authenticated
  using (organization_id = (select public.current_org_id())
         and ((select public.current_org_role()) = 'admin' or entity = 'document'));
create policy ai_usage_logs_read on public.ai_usage_logs for select to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.current_org_role()) = 'admin');
