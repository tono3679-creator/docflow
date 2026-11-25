-- デモ環境の複製
--
-- 訪問者ごとのデモ組織・見本の組織は、元データの組織（is_template）から書類と処理の記録を丸ごと複製して作る。
-- ファイル本体（file_blobs）は内容の SHA-256 で共有するので複製しない。
-- 日時は p_shift だけずらす（元データを作った日時 → 今）。書類に印字された日付（発行日など）は変えない。
-- p_user_map：{"元の利用者ID": "新しい利用者ID"}（記録の操作者を置き換える）

create or replace function app_private.clone_documents(p_from uuid, p_to uuid, p_user_map jsonb, p_shift interval) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  create temp table _dmap on commit drop as
    select d.id old_id, gen_random_uuid() new_id from public.documents d where d.organization_id = p_from;
  create temp table _fmap on commit drop as
    select f.id old_id, gen_random_uuid() new_id from public.document_fields f where f.organization_id = p_from;
  create temp table _jmap on commit drop as
    select j.id old_id, gen_random_uuid() new_id from public.extraction_jobs j where j.organization_id = p_from;
  create temp table _umap on commit drop as
    select key::uuid old_id, value::uuid new_id from jsonb_each_text(coalesce(p_user_map, '{}'::jsonb));

  insert into public.documents (id, organization_id, uploaded_by, filename, file_type, mime_type, file_size, storage_path, preview_path,
    file_hash, document_type, type_source, classification, status, page_count, extraction_method, is_sample, issuer_name,
    document_number, issue_date, total_amount, open_issue_count, error_message, batch_id, version, uploaded_at, processed_at,
    confirmed_at, confirmed_by, created_at, updated_at)
  select m.new_id, p_to, (select u.new_id from _umap u where u.old_id = d.uploaded_by), d.filename, d.file_type, d.mime_type,
    d.file_size, d.storage_path, d.preview_path, d.file_hash, d.document_type, d.type_source, d.classification, d.status,
    d.page_count, d.extraction_method, d.is_sample, d.issuer_name, d.document_number, d.issue_date, d.total_amount,
    d.open_issue_count, d.error_message, d.batch_id, d.version, d.uploaded_at + p_shift, d.processed_at + p_shift,
    d.confirmed_at + p_shift, (select u.new_id from _umap u where u.old_id = d.confirmed_by), d.created_at + p_shift, d.updated_at + p_shift
  from public.documents d join _dmap m on m.old_id = d.id;
  get diagnostics v_count = row_count;

  insert into public.document_pages (organization_id, document_id, page_number, width, height, text_source, ocr_engine, words, mean_confidence)
  select p_to, m.new_id, p.page_number, p.width, p.height, p.text_source, p.ocr_engine, p.words, p.mean_confidence
  from public.document_pages p join _dmap m on m.old_id = p.document_id;

  insert into public.extraction_jobs (id, organization_id, document_id, status, attempts, max_attempts, run_after, last_error,
    requested_by, forced_type, created_at, finished_at)
  select jm.new_id, p_to, m.new_id, j.status, j.attempts, j.max_attempts, j.run_after + p_shift, j.last_error,
    (select u.new_id from _umap u where u.old_id = j.requested_by), j.forced_type, j.created_at + p_shift, j.finished_at + p_shift
  from public.extraction_jobs j join _dmap m on m.old_id = j.document_id join _jmap jm on jm.old_id = j.id
  where j.status not in ('queued', 'running');

  insert into public.extraction_results (organization_id, document_id, job_id, method, ocr_provider, llm_provider, model, is_precomputed,
    document_type, classification, output, duration_ms, processed_at, created_at)
  select p_to, m.new_id, (select jm.new_id from _jmap jm where jm.old_id = r.job_id), r.method, r.ocr_provider, r.llm_provider, r.model,
    r.is_precomputed, r.document_type, r.classification, r.output, r.duration_ms, r.processed_at, r.created_at + p_shift
  from public.extraction_results r join _dmap m on m.old_id = r.document_id;

  insert into public.document_line_items (organization_id, document_id, line_index, page_number, bounding_box)
  select p_to, m.new_id, l.line_index, l.page_number, l.bounding_box
  from public.document_line_items l join _dmap m on m.old_id = l.document_id;

  insert into public.document_fields (id, organization_id, document_id, line_index, field_key, extracted_value, value, confirmed_value,
    page_number, bounding_box, confidence, source_text, source, validation_status, review_status, reviewed_by, reviewed_at,
    created_at, updated_at)
  select fm.new_id, p_to, m.new_id, f.line_index, f.field_key, f.extracted_value, f.value, f.confirmed_value, f.page_number,
    f.bounding_box, f.confidence, f.source_text, f.source, f.validation_status, f.review_status,
    (select u.new_id from _umap u where u.old_id = f.reviewed_by), f.reviewed_at + p_shift, f.created_at + p_shift, f.updated_at + p_shift
  from public.document_fields f join _dmap m on m.old_id = f.document_id join _fmap fm on fm.old_id = f.id;

  insert into public.validation_issues (organization_id, document_id, field_id, issue_key, issue_type, severity, reason, detail,
    status, accept_reason, resolved_by, created_at, resolved_at)
  select p_to, m.new_id, (select fm.new_id from _fmap fm where fm.old_id = i.field_id), i.issue_key, i.issue_type, i.severity,
    i.reason, i.detail, i.status, i.accept_reason, (select u.new_id from _umap u where u.old_id = i.resolved_by),
    i.created_at + p_shift, i.resolved_at + p_shift
  from public.validation_issues i join _dmap m on m.old_id = i.document_id;

  insert into public.review_actions (organization_id, document_id, field_id, actor_id, action, field_key, line_index, before_value,
    after_value, reason, created_at)
  select p_to, m.new_id, (select fm.new_id from _fmap fm where fm.old_id = a.field_id), (select u.new_id from _umap u where u.old_id = a.actor_id),
    a.action, a.field_key, a.line_index, a.before_value, a.after_value, a.reason, a.created_at + p_shift
  from public.review_actions a join _dmap m on m.old_id = a.document_id;

  insert into public.document_confirmations (organization_id, document_id, confirmed_by, confirmed_at, snapshot)
  select p_to, m.new_id, (select u.new_id from _umap u where u.old_id = c.confirmed_by), c.confirmed_at + p_shift, c.snapshot
  from public.document_confirmations c join _dmap m on m.old_id = c.document_id;

  insert into public.duplicate_candidates (organization_id, document_id, other_document_id, kind, matched, status, decided_by, decided_at, created_at)
  select p_to, m.new_id, o.new_id, c.kind, c.matched, c.status, (select u.new_id from _umap u where u.old_id = c.decided_by),
    c.decided_at + p_shift, c.created_at + p_shift
  from public.duplicate_candidates c join _dmap m on m.old_id = c.document_id join _dmap o on o.old_id = c.other_document_id;

  insert into public.export_jobs (organization_id, requested_by, format, target, document_ids, row_count, created_at)
  select p_to, (select u.new_id from _umap u where u.old_id = e.requested_by), e.format, e.target,
    array(select m.new_id from unnest(e.document_ids) x(id) join _dmap m on m.old_id = x.id), e.row_count, e.created_at + p_shift
  from public.export_jobs e where e.organization_id = p_from;

  insert into public.audit_logs (organization_id, actor_id, action, entity, entity_id, detail, created_at)
  select p_to, (select u.new_id from _umap u where u.old_id = a.actor_id), a.action, a.entity,
    coalesce((select m.new_id from _dmap m where m.old_id = a.entity_id), a.entity_id), a.detail, a.created_at + p_shift
  from public.audit_logs a where a.organization_id = p_from;

  insert into public.ai_usage_logs (organization_id, document_id, kind, provider, model, pages, input_tokens, output_tokens, duration_ms,
    success, error, created_at)
  select p_to, (select m.new_id from _dmap m where m.old_id = l.document_id), l.kind, l.provider, l.model, l.pages, l.input_tokens,
    l.output_tokens, l.duration_ms, l.success, l.error, l.created_at + p_shift
  from public.ai_usage_logs l where l.organization_id = p_from;

  drop table _dmap, _fmap, _jmap, _umap;
  return v_count;
end $$;
revoke all on function app_private.clone_documents(uuid, uuid, jsonb, interval) from public, anon, authenticated;
