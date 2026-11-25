-- 業務の書き込みを行う DB 関数
--
-- ログイン利用者は書類・項目・検証結果の表に直接書き込めない（20261121000003 で権限を付けない）。
-- 書き込みはここの関数だけが行い、関数の中で「役割」「書類の状態」「版番号」を確かめる。
-- 検証（金額照合・信頼度・重複など）の計算はサーバー（src/lib/validation）が行い、結果を sync_validation で保存する。
-- 確定できるかどうかは confirm_document が「保存された検証結果」を見て判断する。

-- ---------------------------------------------------------------
-- 共通
-- ---------------------------------------------------------------
create or replace function public.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.organization_id
    from public.organization_members m
   where m.user_id = auth.uid()
     and m.is_active
     and (
       nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id', '') is null
       or m.organization_id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id')::uuid
     )
   order by m.created_at, m.organization_id
   limit 1
$$;

create or replace function public.current_org_role() returns public.org_role
language sql stable security definer set search_path = '' as $$
  select m.role from public.organization_members m
   where m.user_id = auth.uid() and m.organization_id = public.current_org_id() and m.is_active
$$;

create or replace function app_private.require_role(p_roles public.org_role[]) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null then
    raise exception 'ログインしてください' using errcode = '42501';
  end if;
  if not (public.current_org_role() = any (p_roles)) then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;
  return v_org;
end $$;

create or replace function app_private.audit(p_org uuid, p_action text, p_entity text, p_entity_id uuid, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (organization_id, actor_id, action, entity, entity_id, detail)
  values (p_org, auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb))
$$;

create or replace function app_private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger documents_touch before update on public.documents for each row execute function app_private.touch_updated_at();
create trigger fields_touch before update on public.document_fields for each row execute function app_private.touch_updated_at();
create trigger settings_touch before update on public.organization_settings for each row execute function app_private.touch_updated_at();
create trigger profiles_touch before update on public.profiles for each row execute function app_private.touch_updated_at();

-- 書類を自分の組織から行ロック付きで取り出す（無ければ「見つかりません」）
create or replace function app_private.lock_document(p_org uuid, p_document uuid) returns public.documents
language plpgsql security definer set search_path = '' as $$
declare
  v public.documents;
begin
  select * into v from public.documents d where d.id = p_document and d.organization_id = p_org for update;
  if not found then
    raise exception '書類が見つかりません' using errcode = 'P0002';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------
-- アップロード・読取の依頼
-- ---------------------------------------------------------------
create or replace function public.register_document(
  p_filename text, p_file_type text, p_mime_type text, p_file_size integer, p_storage_path text,
  p_preview_path text, p_file_hash text, p_page_count integer, p_batch_id uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_settings public.organization_settings;
  v_id uuid;
begin
  select * into v_settings from public.organization_settings s where s.organization_id = v_org;
  if p_file_size > v_settings.max_file_mb * 1024 * 1024 then
    raise exception 'ファイルが大きすぎます（上限 % MB）', v_settings.max_file_mb using errcode = '22023';
  end if;
  if p_page_count > v_settings.max_pages then
    raise exception 'ページ数が多すぎます（上限 % ページ）', v_settings.max_pages using errcode = '22023';
  end if;
  insert into public.documents (organization_id, uploaded_by, filename, file_type, mime_type, file_size, storage_path,
                                preview_path, file_hash, page_count, batch_id, status)
  values (v_org, auth.uid(), p_filename, p_file_type, p_mime_type, p_file_size, p_storage_path,
          p_preview_path, p_file_hash, p_page_count, p_batch_id, 'queued')
  returning id into v_id;
  insert into public.extraction_jobs (organization_id, document_id, requested_by) values (v_org, v_id, auth.uid());
  perform app_private.audit(v_org, 'document.upload', 'document', v_id,
    jsonb_build_object('filename', p_filename, 'size', p_file_size, 'pages', p_page_count));
  return v_id;
end $$;

-- 読み直し（失敗した処理の手動再実行・書類種別を指定しての読み直し）。同じ書類で処理中のものがあればそれを返す
create or replace function public.request_extraction(p_document uuid, p_forced_type public.document_type default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_doc public.documents := app_private.lock_document(v_org, p_document);
  v_job uuid;
begin
  if v_doc.status in ('confirmed', 'excluded') then
    raise exception '確定済み・除外した書類は読み直せません' using errcode = '55000';
  end if;
  select j.id into v_job from public.extraction_jobs j where j.document_id = p_document and j.status in ('queued', 'running');
  if v_job is not null then
    return v_job;
  end if;
  insert into public.extraction_jobs (organization_id, document_id, requested_by, forced_type)
  values (v_org, p_document, auth.uid(), p_forced_type) returning id into v_job;
  update public.documents set status = 'queued', error_message = null, version = version + 1 where id = p_document;
  if p_forced_type is not null then
    insert into public.review_actions (organization_id, document_id, actor_id, action, before_value, after_value)
    values (v_org, p_document, auth.uid(), 'change_type', v_doc.document_type::text, p_forced_type::text);
  end if;
  perform app_private.audit(v_org, 'document.reprocess', 'document', p_document,
    jsonb_build_object('forced_type', p_forced_type));
  return v_job;
end $$;

-- ---------------------------------------------------------------
-- 確認・修正
-- ---------------------------------------------------------------
-- p_changes：次の操作の配列（順に適用）
--   {"op":"set","field_id":…,"value":"…"}                       値の修正（確認済みは未確認に戻る）
--   {"op":"set","field_id":…,"review_status":"confirmed"}        確認済みにする（value も同時に渡せる）
--   {"op":"add_line","line_index":n,"keys":["description",…]}   明細の行を追加
--   {"op":"remove_line","line_index":n}                          明細の行を削除
--   {"op":"accept_issue","issue_id":…,"reason":"…"}              不整合を理由付きで承認
--   {"op":"reopen_issue","issue_id":…}                           承認を取り消す
-- 修正しただけでは確認済みにしない（review_status を明示したときだけ確認済みになる）。
create or replace function public.apply_review_changes(p_document uuid, p_version integer, p_changes jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_doc public.documents := app_private.lock_document(v_org, p_document);
  v_change jsonb;
  v_field public.document_fields;
  v_issue public.validation_issues;
  v_new_value text;
  v_new_status public.review_status;
  v_value_changed boolean;
  v_key text;
  v_line integer;
begin
  if v_doc.version <> p_version then
    raise exception 'この書類は他の操作で更新されています。画面を再読み込みしてください' using errcode = '40001';
  end if;
  if v_doc.status not in ('needs_review', 'ready', 'error') then
    raise exception 'この状態の書類は修正できません（確定済みなら「再確認」してください）' using errcode = '55000';
  end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 500 then
    raise exception '変更の形式が正しくありません' using errcode = '22023';
  end if;

  for v_change in select * from jsonb_array_elements(p_changes) loop
    case v_change ->> 'op'
    when 'set' then
      select * into v_field from public.document_fields f
       where f.id = (v_change ->> 'field_id')::uuid and f.document_id = p_document for update;
      if not found then
        raise exception '項目が見つかりません' using errcode = 'P0002';
      end if;
      v_new_value := case when v_change ? 'value' then nullif(btrim(v_change ->> 'value'), '') else v_field.value end;
      v_value_changed := v_new_value is distinct from v_field.value;
      v_new_status := coalesce((v_change ->> 'review_status')::public.review_status,
                               case when v_value_changed then 'unreviewed'::public.review_status else v_field.review_status end);
      if char_length(v_new_value) > 1000 then
        raise exception '値が長すぎます' using errcode = '22023';
      end if;
      update public.document_fields set
        value = v_new_value,
        source = case when v_value_changed then 'user' else source end,
        review_status = v_new_status,
        reviewed_by = case when v_new_status = 'confirmed' then auth.uid() else null end,
        reviewed_at = case when v_new_status = 'confirmed' then now() else null end
       where id = v_field.id;
      if v_value_changed then
        insert into public.review_actions (organization_id, document_id, field_id, actor_id, action, field_key, line_index, before_value, after_value)
        values (v_org, p_document, v_field.id, auth.uid(), 'edit', v_field.field_key, v_field.line_index, v_field.value, v_new_value);
      end if;
      if v_new_status is distinct from v_field.review_status then
        insert into public.review_actions (organization_id, document_id, field_id, actor_id, action, field_key, line_index, after_value)
        values (v_org, p_document, v_field.id, auth.uid(),
                case when v_new_status = 'confirmed' then 'confirm_field' else 'unconfirm_field' end,
                v_field.field_key, v_field.line_index, v_new_value);
      end if;
    when 'add_line' then
      v_line := (v_change ->> 'line_index')::integer;
      if v_line is null or v_line < 0 or v_line > 500 then
        raise exception '明細の行番号が正しくありません' using errcode = '22023';
      end if;
      insert into public.document_line_items (organization_id, document_id, line_index) values (v_org, p_document, v_line);
      for v_key in select jsonb_array_elements_text(v_change -> 'keys') loop
        insert into public.document_fields (organization_id, document_id, line_index, field_key, source)
        values (v_org, p_document, v_line, v_key, 'user');
      end loop;
      insert into public.review_actions (organization_id, document_id, actor_id, action, line_index)
      values (v_org, p_document, auth.uid(), 'add_line', v_line);
    when 'remove_line' then
      v_line := (v_change ->> 'line_index')::integer;
      delete from public.document_fields f where f.document_id = p_document and f.line_index = v_line;
      delete from public.document_line_items l where l.document_id = p_document and l.line_index = v_line;
      if not found then
        raise exception '明細の行が見つかりません' using errcode = 'P0002';
      end if;
      insert into public.review_actions (organization_id, document_id, actor_id, action, line_index)
      values (v_org, p_document, auth.uid(), 'remove_line', v_line);
    when 'accept_issue' then
      select * into v_issue from public.validation_issues i
       where i.id = (v_change ->> 'issue_id')::uuid and i.document_id = p_document for update;
      if not found then
        raise exception '確認事項が見つかりません' using errcode = 'P0002';
      end if;
      if char_length(btrim(coalesce(v_change ->> 'reason', ''))) = 0 then
        raise exception '承認の理由を入力してください' using errcode = '22023';
      end if;
      update public.validation_issues set status = 'accepted', accept_reason = left(btrim(v_change ->> 'reason'), 300),
             resolved_by = auth.uid(), resolved_at = now()
       where id = v_issue.id;
      insert into public.review_actions (organization_id, document_id, field_id, actor_id, action, after_value, reason)
      values (v_org, p_document, v_issue.field_id, auth.uid(), 'accept_issue', v_issue.reason, left(btrim(v_change ->> 'reason'), 300));
    when 'reopen_issue' then
      update public.validation_issues set status = 'open', accept_reason = null, resolved_by = null, resolved_at = null
       where id = (v_change ->> 'issue_id')::uuid and document_id = p_document and status = 'accepted';
      insert into public.review_actions (organization_id, document_id, actor_id, action)
      values (v_org, p_document, auth.uid(), 'reopen_issue');
    else
      raise exception '不明な操作です' using errcode = '22023';
    end case;
  end loop;

  update public.documents set version = version + 1 where id = p_document;
  return v_doc.version + 1;
end $$;

-- 検証結果の保存（サーバーが計算した結果を受け取る）。読取処理（worker）からも同じ内部関数を使う
--   p_payload = {
--     "fields":   [{"id":…, "validation_status":"ok|needs_review|inconsistent|missing"}],
--     "issues":   [{"key":…, "field_id":…|null, "type":…, "severity":"warning|error", "reason":…, "detail":{…, "sig":…}}],
--     "duplicates": [{"other_document_id":…, "kind":…, "matched":{…}}],
--     "summary":  {"issuer_name":…, "document_number":…, "issue_date":"YYYY-MM-DD"|null, "total_amount":n|null}
--   }
create or replace function app_private.sync_validation(p_org uuid, p_document uuid, p_payload jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_issue jsonb;
  v_existing public.validation_issues;
  v_open integer;
  v_keys text[] := '{}';
  v_dups uuid[] := '{}';
  v_dup jsonb;
  v_summary jsonb := coalesce(p_payload -> 'summary', '{}'::jsonb);
begin
  -- 項目の検証状態
  update public.document_fields f set validation_status = (x ->> 'validation_status')::public.validation_status
    from jsonb_array_elements(coalesce(p_payload -> 'fields', '[]'::jsonb)) x
   where f.id = (x ->> 'id')::uuid and f.document_id = p_document
     and f.validation_status is distinct from (x ->> 'validation_status')::public.validation_status;

  -- 重複の候補（判断済みのものは残す。条件に当たらなくなった未判断の候補は消す）
  for v_dup in select * from jsonb_array_elements(coalesce(p_payload -> 'duplicates', '[]'::jsonb)) loop
    v_dups := v_dups || (v_dup ->> 'other_document_id')::uuid;
    insert into public.duplicate_candidates (organization_id, document_id, other_document_id, kind, matched)
    values (p_org, p_document, (v_dup ->> 'other_document_id')::uuid, v_dup ->> 'kind', coalesce(v_dup -> 'matched', '{}'::jsonb))
    on conflict (document_id, other_document_id) do update set kind = excluded.kind, matched = excluded.matched;
  end loop;
  delete from public.duplicate_candidates c
   where c.document_id = p_document and c.status = 'pending' and not (c.other_document_id = any (v_dups));

  -- 確認事項：新しいものは追加、続いているものは内容を更新、無くなったものは解消
  for v_issue in select * from jsonb_array_elements(coalesce(p_payload -> 'issues', '[]'::jsonb)) loop
    v_keys := v_keys || (v_issue ->> 'key');
    select * into v_existing from public.validation_issues i where i.document_id = p_document and i.issue_key = v_issue ->> 'key' for update;
    if not found then
      insert into public.validation_issues (organization_id, document_id, field_id, issue_key, issue_type, severity, reason, detail)
      values (p_org, p_document, nullif(v_issue ->> 'field_id', '')::uuid, v_issue ->> 'key', v_issue ->> 'type',
              (v_issue ->> 'severity')::public.issue_severity, left(v_issue ->> 'reason', 200), coalesce(v_issue -> 'detail', '{}'::jsonb));
    else
      update public.validation_issues set
        field_id = nullif(v_issue ->> 'field_id', '')::uuid,
        issue_type = v_issue ->> 'type',
        severity = (v_issue ->> 'severity')::public.issue_severity,
        reason = left(v_issue ->> 'reason', 200),
        detail = coalesce(v_issue -> 'detail', '{}'::jsonb),
        -- 承認したときと内容（sig：関係する値）が変わっていれば、もう一度確認が要る
        status = case
          when v_existing.status = 'accepted' and (v_existing.detail ->> 'sig') is not distinct from (v_issue -> 'detail' ->> 'sig') then 'accepted'
          else 'open' end::public.issue_status,
        accept_reason = case
          when v_existing.status = 'accepted' and (v_existing.detail ->> 'sig') is not distinct from (v_issue -> 'detail' ->> 'sig') then v_existing.accept_reason
          else null end,
        resolved_at = case
          when v_existing.status = 'accepted' and (v_existing.detail ->> 'sig') is not distinct from (v_issue -> 'detail' ->> 'sig') then v_existing.resolved_at
          else null end,
        resolved_by = case
          when v_existing.status = 'accepted' and (v_existing.detail ->> 'sig') is not distinct from (v_issue -> 'detail' ->> 'sig') then v_existing.resolved_by
          else null end
       where id = v_existing.id;
    end if;
  end loop;
  -- 無くなった確認事項は解消（承認済みのものも。同じ内容がまた出たら、もう一度確認が要る）
  update public.validation_issues i set status = 'resolved', resolved_at = now(), resolved_by = auth.uid()
   where i.document_id = p_document and i.status in ('open', 'accepted') and not (i.issue_key = any (v_keys));

  select count(*)::integer into v_open from public.validation_issues i where i.document_id = p_document and i.status = 'open';
  update public.documents d set
    open_issue_count = v_open,
    issuer_name = left(nullif(v_summary ->> 'issuer_name', ''), 200),
    document_number = left(nullif(v_summary ->> 'document_number', ''), 100),
    issue_date = nullif(v_summary ->> 'issue_date', '')::date,
    total_amount = nullif(v_summary ->> 'total_amount', '')::bigint,
    status = case when d.status in ('needs_review', 'ready') then
               (case when v_open > 0 then 'needs_review' else 'ready' end)::public.document_status
             else d.status end
   where d.id = p_document;
  return v_open;
end $$;

create or replace function public.sync_validation(p_document uuid, p_payload jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_doc public.documents := app_private.lock_document(v_org, p_document);
begin
  if v_doc.status in ('confirmed', 'excluded', 'queued', 'processing') then
    return v_doc.open_issue_count;
  end if;
  return app_private.sync_validation(v_org, p_document, p_payload);
end $$;

-- ---------------------------------------------------------------
-- 確定・再確認
-- ---------------------------------------------------------------
create or replace function public.confirm_document(p_document uuid, p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_doc public.documents := app_private.lock_document(v_org, p_document);
  v_limit bigint;
  v_open integer;
  v_pending integer;
  v_snapshot jsonb;
begin
  if v_doc.version <> p_version then
    raise exception 'この書類は他の操作で更新されています。画面を再読み込みしてください' using errcode = '40001';
  end if;
  if v_doc.status not in ('needs_review', 'ready') then
    raise exception 'この状態の書類は確定できません' using errcode = '55000';
  end if;
  if v_doc.document_type is null or v_doc.document_type = 'unknown' then
    raise exception '書類種別を選んでください' using errcode = '55000';
  end if;
  select count(*)::integer into v_open from public.validation_issues i where i.document_id = p_document and i.status = 'open';
  if v_open > 0 then
    raise exception '未確認の項目が % 件あります', v_open using errcode = '55000';
  end if;
  select count(*)::integer into v_pending from public.duplicate_candidates c where c.document_id = p_document and c.status = 'pending';
  if v_pending > 0 then
    raise exception '重複の疑いを確認してください' using errcode = '55000';
  end if;
  if public.current_org_role() = 'staff' then
    select s.staff_confirm_limit into v_limit from public.organization_settings s where s.organization_id = v_org;
    if v_limit is not null and coalesce(v_doc.total_amount, 0) > v_limit then
      raise exception '合計 % 円を超える書類は管理者が確定します', v_limit using errcode = '42501';
    end if;
  end if;

  update public.document_fields set confirmed_value = value where document_id = p_document;
  select jsonb_build_object(
    'document_type', v_doc.document_type,
    'fields', coalesce(jsonb_agg(jsonb_build_object('key', f.field_key, 'line', f.line_index, 'value', f.value,
                                                    'extracted', f.extracted_value) order by f.line_index nulls first, f.field_key), '[]'::jsonb))
    into v_snapshot from public.document_fields f where f.document_id = p_document;
  insert into public.document_confirmations (organization_id, document_id, confirmed_by, snapshot)
  values (v_org, p_document, auth.uid(), v_snapshot);
  update public.documents set status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid(), version = version + 1
   where id = p_document;
  insert into public.review_actions (organization_id, document_id, actor_id, action)
  values (v_org, p_document, auth.uid(), 'confirm_document');
  perform app_private.audit(v_org, 'document.confirm', 'document', p_document,
    jsonb_build_object('total_amount', v_doc.total_amount, 'document_type', v_doc.document_type));
end $$;

-- 確定後に直すとき：理由を残して「確認中」に戻す（確定時の値は document_confirmations に残る）
create or replace function public.reopen_document(p_document uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_doc public.documents := app_private.lock_document(v_org, p_document);
begin
  if v_doc.status <> 'confirmed' then
    raise exception '確定済みの書類ではありません' using errcode = '55000';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception '再確認の理由を入力してください' using errcode = '22023';
  end if;
  update public.documents set status = case when open_issue_count > 0 then 'needs_review' else 'ready' end::public.document_status,
         confirmed_at = null, confirmed_by = null, version = version + 1
   where id = p_document;
  insert into public.review_actions (organization_id, document_id, actor_id, action, reason)
  values (v_org, p_document, auth.uid(), 'reopen_document', left(btrim(p_reason), 300));
  perform app_private.audit(v_org, 'document.reopen', 'document', p_document, jsonb_build_object('reason', left(btrim(p_reason), 300)));
end $$;

-- 重複の判断（自動では消さない）
create or replace function public.decide_duplicate(p_candidate uuid, p_decision public.duplicate_status) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_candidate public.duplicate_candidates;
  v_doc public.documents;
begin
  select * into v_candidate from public.duplicate_candidates c where c.id = p_candidate and c.organization_id = v_org for update;
  if not found then
    raise exception '重複の候補が見つかりません' using errcode = 'P0002';
  end if;
  v_doc := app_private.lock_document(v_org, v_candidate.document_id);
  if v_doc.status = 'confirmed' then
    raise exception '確定済みの書類です' using errcode = '55000';
  end if;
  update public.duplicate_candidates set status = p_decision,
         decided_by = case when p_decision = 'pending' then null else auth.uid() end,
         decided_at = case when p_decision = 'pending' then null else now() end
   where id = p_candidate;
  update public.documents set version = version + 1 where id = v_candidate.document_id;
  insert into public.review_actions (organization_id, document_id, actor_id, action, after_value)
  values (v_org, v_candidate.document_id, auth.uid(), 'duplicate_decision', p_decision::text);
  return v_candidate.document_id;
end $$;

-- 除外（重複など。消さずに一覧の既定の表示から外す）・戻す
create or replace function public.set_document_excluded(p_document uuid, p_excluded boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_doc public.documents := app_private.lock_document(v_org, p_document);
begin
  if p_excluded then
    if v_doc.status in ('confirmed', 'queued', 'processing', 'excluded') then
      raise exception 'この状態の書類は除外できません' using errcode = '55000';
    end if;
    update public.documents set status = 'excluded', version = version + 1 where id = p_document;
  else
    if v_doc.status <> 'excluded' then
      raise exception '除外した書類ではありません' using errcode = '55000';
    end if;
    update public.documents set status = case when open_issue_count > 0 then 'needs_review' else 'ready' end::public.document_status,
           version = version + 1
     where id = p_document;
  end if;
  insert into public.review_actions (organization_id, document_id, actor_id, action, reason)
  values (v_org, p_document, auth.uid(), case when p_excluded then 'exclude' else 'restore' end, left(btrim(coalesce(p_reason, '')), 300));
  perform app_private.audit(v_org, case when p_excluded then 'document.exclude' else 'document.restore' end, 'document', p_document,
    jsonb_build_object('reason', left(btrim(coalesce(p_reason, '')), 300)));
end $$;

-- 削除（管理者のみ）。ファイル本体の削除はサーバーが行う（ほかの書類が参照していなければ）
create or replace function public.delete_document(p_document uuid) returns table (storage_path text, preview_path text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin']::public.org_role[]);
  v_doc public.documents := app_private.lock_document(v_org, p_document);
begin
  delete from public.documents d where d.id = p_document;
  perform app_private.audit(v_org, 'document.delete', 'document', p_document,
    jsonb_build_object('filename', v_doc.filename, 'status', v_doc.status));
  return query select v_doc.storage_path, v_doc.preview_path;
end $$;

-- 出力の記録
create or replace function public.record_export(p_format text, p_target text, p_document_ids uuid[], p_row_count integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.require_role(array['admin', 'staff']::public.org_role[]);
  v_id uuid;
begin
  if exists (select 1 from unnest(p_document_ids) x(id)
              where not exists (select 1 from public.documents d where d.id = x.id and d.organization_id = v_org)) then
    raise exception '書類が見つかりません' using errcode = 'P0002';
  end if;
  insert into public.export_jobs (organization_id, requested_by, format, target, document_ids, row_count)
  values (v_org, auth.uid(), p_format, p_target, p_document_ids, p_row_count) returning id into v_id;
  perform app_private.audit(v_org, 'export.create', 'export', v_id,
    jsonb_build_object('format', p_format, 'target', p_target, 'documents', cardinality(p_document_ids), 'rows', p_row_count));
  return v_id;
end $$;
