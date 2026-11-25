import "server-only";
/**
 * 画面のためのデータの取得。すべてログイン利用者の接続（RLS 付き）で読む（別の組織の行は見えない）。
 */
import type { Tx } from "@/lib/db";
import type { DocumentStatus } from "@/lib/domain/labels";
import type { DocumentType, ExtractionOutput } from "@/lib/extraction/types";
import type { AmountCheck } from "@/lib/validation/reconcile";

export type DocumentListRow = {
  id: string;
  filename: string;
  file_type: string;
  document_type: DocumentType | null;
  status: DocumentStatus;
  issuer_name: string | null;
  document_number: string | null;
  issue_date: string | null;
  total_amount: number | null;
  open_issue_count: number;
  page_count: number;
  uploaded_at: Date;
  confirmed_at: Date | null;
  is_sample: boolean;
  error_message: string | null;
};

export type DocumentFilter = {
  q?: string;
  status?: string;
  type?: string;
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
};

export const STATUS_FILTERS = ["active", "queued", "processing", "needs_review", "ready", "confirmed", "error", "excluded", "all"] as const;

export async function listDocuments(tx: Tx, f: DocumentFilter): Promise<{ rows: DocumentListRow[]; total: number }> {
  const q = (f.q ?? "").trim().slice(0, 100);
  const status = f.status && (STATUS_FILTERS as readonly string[]).includes(f.status) ? f.status : "active";
  const type = ["invoice", "receipt", "delivery_note", "unknown"].includes(f.type ?? "") ? f.type! : "";
  const perPage = Math.min(Math.max(f.perPage ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(f.from ?? "") ? f.from! : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(f.to ?? "") ? f.to! : null;
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await tx<(DocumentListRow & { total: number })[]>`
    select id, filename, file_type, document_type, status, issuer_name, document_number, issue_date, total_amount, open_issue_count,
           page_count, uploaded_at, confirmed_at, is_sample, error_message, count(*) over ()::int total
      from documents
     where (${status} = 'all' or (${status} = 'active' and status <> 'excluded') or status::text = ${status})
       and (${type} = '' or document_type::text = ${type} or (${type} = 'unknown' and document_type is null))
       and (${q} = '' or filename ilike ${like} or issuer_name ilike ${like} or document_number ilike ${like})
       and (${from}::date is null or issue_date >= ${from}::date)
       and (${to}::date is null or issue_date <= ${to}::date)
     order by case status when 'needs_review' then 0 when 'error' then 1 when 'ready' then 2 when 'processing' then 3 when 'queued' then 4 else 5 end,
              uploaded_at desc, id
     limit ${perPage} offset ${(page - 1) * perPage}`;
  return { rows, total: rows[0]?.total ?? 0 };
}

export type DashboardStats = {
  queued: number;
  needsReview: number;
  ready: number;
  confirmed: number;
  thisMonth: number;
  errors: number;
};

export async function dashboardStats(tx: Tx, monthStart: string, timezone: string): Promise<DashboardStats> {
  const [row] = await tx<DashboardStats[]>`
    select count(*) filter (where status in ('queued', 'processing'))::int "queued",
           count(*) filter (where status = 'needs_review')::int "needsReview",
           count(*) filter (where status = 'ready')::int ready,
           count(*) filter (where status = 'confirmed')::int confirmed,
           count(*) filter (where processed_at is not null and (processed_at at time zone ${timezone})::date >= ${monthStart}::date)::int "thisMonth",
           count(*) filter (where status = 'error')::int errors
      from documents where status <> 'excluded'`;
  return row;
}

export async function reviewQueue(tx: Tx, limit: number): Promise<DocumentListRow[]> {
  return tx<DocumentListRow[]>`
    select id, filename, file_type, document_type, status, issuer_name, document_number, issue_date, total_amount, open_issue_count,
           page_count, uploaded_at, confirmed_at, is_sample, error_message
      from documents where status in ('needs_review', 'error')
     order by open_issue_count desc, uploaded_at limit ${limit}`;
}

export async function recentDocuments(tx: Tx, limit: number): Promise<DocumentListRow[]> {
  return tx<DocumentListRow[]>`
    select id, filename, file_type, document_type, status, issuer_name, document_number, issue_date, total_amount, open_issue_count,
           page_count, uploaded_at, confirmed_at, is_sample, error_message
      from documents where status <> 'excluded'
     order by greatest(uploaded_at, coalesce(processed_at, uploaded_at), coalesce(confirmed_at, uploaded_at)) desc limit ${limit}`;
}

// ---------------------------------------------------------------
// 確認画面
// ---------------------------------------------------------------
export type FieldRow = {
  id: string;
  field_key: string;
  line_index: number | null;
  extracted_value: string | null;
  value: string | null;
  confirmed_value: string | null;
  page_number: number | null;
  bounding_box: { x: number; y: number; w: number; h: number } | null;
  confidence: number | null;
  source_text: string | null;
  source: "pdf_text" | "ocr" | "user";
  validation_status: "ok" | "needs_review" | "inconsistent" | "missing";
  review_status: "unreviewed" | "confirmed";
  reviewed_at: Date | null;
};

export type IssueRow = {
  id: string;
  field_id: string | null;
  issue_key: string;
  issue_type: string;
  severity: "warning" | "error";
  reason: string;
  detail: Record<string, unknown>;
  status: "open" | "resolved" | "accepted";
  accept_reason: string | null;
};

export type DuplicateRow = {
  id: string;
  other_document_id: string;
  kind: "exact_file" | "same_number" | "similar";
  matched: Record<string, unknown>;
  status: "pending" | "not_duplicate" | "duplicate";
  other_filename: string;
  other_status: DocumentStatus;
};

export type DocumentDetail = {
  doc: DocumentListRow & {
    mime_type: string;
    file_size: number;
    preview_path: string | null;
    type_source: "ai" | "user" | null;
    classification: { scores?: Record<string, number>; evidence?: string[]; method?: string };
    extraction_method: string | null;
    version: number;
    processed_at: Date | null;
    confirmed_by_name: string | null;
    uploaded_by_name: string | null;
  };
  pages: { page_number: number; width: number; height: number; text_source: string; mean_confidence: number | null }[];
  fields: FieldRow[];
  lineItems: { line_index: number; page_number: number | null; bounding_box: { x: number; y: number; w: number; h: number } | null }[];
  issues: IssueRow[];
  duplicates: DuplicateRow[];
  result: { method: string; is_precomputed: boolean; model: string | null; llm_provider: string | null; ocr_provider: string | null; processed_at: Date; notes: string[]; checks: AmountCheck[] | null } | null;
  job: { status: string; attempts: number; max_attempts: number; last_error: string | null; run_after: Date } | null;
};

export async function getDocumentDetail(tx: Tx, id: string): Promise<DocumentDetail | null> {
  const [doc] = await tx<DocumentDetail["doc"][]>`
    select d.id, d.filename, d.file_type, d.document_type, d.status, d.issuer_name, d.document_number, d.issue_date, d.total_amount,
           d.open_issue_count, d.page_count, d.uploaded_at, d.confirmed_at, d.is_sample, d.error_message, d.mime_type, d.file_size,
           d.preview_path, d.type_source, d.classification, d.extraction_method, d.version, d.processed_at,
           cp.display_name confirmed_by_name, up.display_name uploaded_by_name
      from documents d
      left join profiles cp on cp.id = d.confirmed_by
      left join profiles up on up.id = d.uploaded_by
     where d.id = ${id}`;
  if (!doc) return null;
  const [pages, fields, lineItems, issues, duplicates, results, jobs] = await Promise.all([
    tx<DocumentDetail["pages"]>`select page_number, width, height, text_source, mean_confidence from document_pages where document_id = ${id} order by page_number`,
    tx<FieldRow[]>`
      select id, field_key, line_index, extracted_value, value, confirmed_value, page_number, bounding_box, confidence, source_text, source,
             validation_status, review_status, reviewed_at
        from document_fields where document_id = ${id}`,
    tx<DocumentDetail["lineItems"]>`select line_index, page_number, bounding_box from document_line_items where document_id = ${id} order by line_index`,
    tx<IssueRow[]>`
      select id, field_id, issue_key, issue_type, severity, reason, detail, status, accept_reason
        from validation_issues where document_id = ${id} and status <> 'resolved'
       order by case severity when 'error' then 0 else 1 end, created_at`,
    tx<DuplicateRow[]>`
      select c.id, c.other_document_id, c.kind, c.matched, c.status, o.filename other_filename, o.status other_status
        from duplicate_candidates c join documents o on o.id = c.other_document_id
       where c.document_id = ${id} order by c.created_at`,
    tx<{ method: string; is_precomputed: boolean; model: string | null; llm_provider: string | null; ocr_provider: string | null; processed_at: Date; output: ExtractionOutput }[]>`
      select method, is_precomputed, model, llm_provider, ocr_provider, processed_at, output from extraction_results
       where document_id = ${id} order by created_at desc limit 1`,
    tx<NonNullable<DocumentDetail["job"]>[]>`
      select status, attempts, max_attempts, last_error, run_after from extraction_jobs where document_id = ${id} order by created_at desc limit 1`,
  ]);
  const r = results[0];
  return {
    doc,
    pages,
    fields,
    lineItems,
    issues,
    duplicates,
    result: r ? { method: r.method, is_precomputed: r.is_precomputed, model: r.model, llm_provider: r.llm_provider, ocr_provider: r.ocr_provider, processed_at: r.processed_at, notes: r.output.notes ?? [], checks: null } : null,
    job: jobs[0] ?? null,
  };
}

/** 確認画面の「前の書類・次の要確認」 */
export async function neighbors(tx: Tx, id: string): Promise<{ prev: string | null; nextReview: string | null }> {
  const [row] = await tx<{ prev: string | null; next_review: string | null }[]>`
    with cur as (select uploaded_at, id from documents where id = ${id})
    select (select d.id from documents d, cur where d.status <> 'excluded' and (d.uploaded_at, d.id) > (cur.uploaded_at, cur.id)
             order by d.uploaded_at, d.id limit 1) prev,
           coalesce(
             (select d.id from documents d, cur where d.status = 'needs_review' and d.id <> cur.id and (d.uploaded_at, d.id) < (cur.uploaded_at, cur.id)
               order by d.uploaded_at desc, d.id desc limit 1),
             (select d.id from documents d, cur where d.status = 'needs_review' and d.id <> cur.id order by d.uploaded_at desc, d.id desc limit 1)) next_review`;
  return { prev: row?.prev ?? null, nextReview: row?.next_review ?? null };
}

// ---------------------------------------------------------------
// 履歴
// ---------------------------------------------------------------
export type HistoryRow = {
  id: string;
  at: Date;
  kind: "review" | "audit";
  action: string;
  actor_name: string | null;
  document_id: string | null;
  filename: string | null;
  field_key: string | null;
  line_index: number | null;
  before_value: string | null;
  after_value: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
};

export async function documentHistory(tx: Tx, documentId: string): Promise<HistoryRow[]> {
  return tx<HistoryRow[]>`
    select * from (
      select 'r' || a.id id, a.created_at at, 'review' kind, a.action, p.display_name actor_name, a.document_id, null filename,
             a.field_key, a.line_index, a.before_value, a.after_value, a.reason, null::jsonb detail
        from review_actions a left join profiles p on p.id = a.actor_id where a.document_id = ${documentId}
      union all
      select 'a' || l.id, l.created_at, 'audit', l.action, p.display_name, l.entity_id, null, null, null, null, null, null, l.detail
        from audit_logs l left join profiles p on p.id = l.actor_id
       where l.entity = 'document' and l.entity_id = ${documentId}
         and l.action in ('document.upload', 'document.processed', 'document.failed', 'document.reprocess')
    ) x order by at desc limit 200`;
}

export async function orgHistory(tx: Tx, opts: { limit: number; actions?: string[] }): Promise<HistoryRow[]> {
  const actions = opts.actions ?? [];
  return tx<HistoryRow[]>`
    select * from (
      select 'r' || a.id id, a.created_at at, 'review' kind, a.action, p.display_name actor_name, a.document_id, d.filename,
             a.field_key, a.line_index, a.before_value, a.after_value, a.reason, null::jsonb detail
        from review_actions a left join profiles p on p.id = a.actor_id left join documents d on d.id = a.document_id
      union all
      select 'a' || l.id, l.created_at, 'audit', l.action, p.display_name, case when l.entity = 'document' then l.entity_id end,
             d.filename, null, null, null, null, null, l.detail
        from audit_logs l left join profiles p on p.id = l.actor_id left join documents d on d.id = l.entity_id and l.entity = 'document'
       where l.action not in ('document.confirm', 'document.reopen', 'document.exclude', 'document.restore')
    ) x
    where (cardinality(${actions}::text[]) = 0 or x.action = any(${actions}::text[]))
    order by at desc limit ${opts.limit}`;
}

export async function exportHistory(tx: Tx, limit: number) {
  return tx<{ id: string; format: string; target: string; row_count: number; created_at: Date; documents: number; actor_name: string | null }[]>`
    select e.id, e.format, e.target, e.row_count, e.created_at, cardinality(e.document_ids) documents, p.display_name actor_name
      from export_jobs e left join profiles p on p.id = e.requested_by order by e.created_at desc limit ${limit}`;
}
