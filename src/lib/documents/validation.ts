import "server-only";
/**
 * 保存されている項目の値から検証をやり直し、結果（確認事項・項目の状態・重複・一覧用の要約）を DB に保存する。
 * 読取の直後（worker：DB の所有者の接続）と、利用者が修正・確認したあと（ログイン利用者の接続・RLS 付き）の両方で使う。
 * どちらの接続でも、読む行は organization_id で絞る。
 */
import type { Sql, TransactionSql } from "postgres";
import type { DocumentContext, DocumentType, ExtractionOutput } from "@/lib/extraction/types";
import { findDuplicates, type DupDoc } from "@/lib/validation/duplicates";
import { validateDocument, type FieldState, type ValidateResult } from "@/lib/validation/validate";

type Q = Sql | TransactionSql;

const EMPTY_CONTEXT: DocumentContext = { textFound: true, taxIncluded: null, rounding: null, statedRates: [], hasReducedMarker: false };
const refKey = (key: string, line: number | null) => (line === null ? key : `line.${line}.${key}`);

export type FieldRow = {
  id: string;
  field_key: string;
  line_index: number | null;
  value: string | null;
  has_box: boolean;
  confidence: number | null;
  source: "pdf_text" | "ocr" | "user";
  review_status: "unreviewed" | "confirmed";
};

export async function computeValidation(q: Q, orgId: string, documentId: string): Promise<{ result: ValidateResult; payload: Record<string, unknown> } | null> {
  const [doc] = await q<{ id: string; document_type: DocumentType | null; file_hash: string; uploaded_at: Date; filename: string; status: string }[]>`
    select id, document_type, file_hash, uploaded_at, filename, status from documents where id = ${documentId} and organization_id = ${orgId}`;
  if (!doc) return null;
  const fields = await q<FieldRow[]>`
    select id, field_key, line_index, value, bounding_box is not null has_box, confidence, source, review_status
      from document_fields where document_id = ${documentId} and organization_id = ${orgId}`;
  const [latest] = await q<{ output: ExtractionOutput }[]>`
    select output from extraction_results where document_id = ${documentId} and organization_id = ${orgId}
     order by created_at desc limit 1`;
  const [settings] = await q<{ confidence_threshold: number }[]>`
    select confidence_threshold from organization_settings where organization_id = ${orgId}`;
  const accepted = await q<{ issue_key: string; sig: string | null }[]>`
    select issue_key, detail ->> 'sig' sig from validation_issues
     where document_id = ${documentId} and organization_id = ${orgId} and status = 'accepted'`;

  // 読取で見つかった「同じ項目の別の記載」（値を直したあとも、今の値と違うものだけを矛盾として出す）
  const conflicts: Record<string, string[]> = {};
  for (const f of latest?.output.fields ?? []) {
    if (f.conflicts?.length) conflicts[refKey(f.key, f.line)] = f.conflicts.map((c) => c.value);
  }

  const states: FieldState[] = fields.map((f) => ({
    id: f.id,
    key: f.field_key,
    line: f.line_index,
    value: f.value,
    hasSource: f.has_box,
    conf: f.confidence,
    source: f.source,
    reviewStatus: f.review_status,
  }));

  // まず重複を見ずに要約（発行元・番号・日付・合計）を作り、それで重複の候補を探す
  const first = validateDocument({
    documentType: doc.document_type,
    fields: states,
    conflicts,
    context: latest?.output.context ?? EMPTY_CONTEXT,
    threshold: settings?.confidence_threshold ?? 0.8,
    duplicates: [],
    accepted: {},
  });
  const others = await q<{ id: string; file_hash: string; document_type: string | null; issuer_name: string | null; document_number: string | null; issue_date: string | null; total_amount: number | null; uploaded_at: Date; filename: string }[]>`
    select id, file_hash, document_type, issuer_name, document_number, issue_date, total_amount, uploaded_at, filename
      from documents
     where organization_id = ${orgId} and id <> ${documentId} and status <> 'excluded'
       and (file_hash = ${doc.file_hash}
            or (document_type = ${doc.document_type ?? "unknown"}
                and (document_number = ${first.summary.document_number ?? ""}
                     or (issue_date = ${first.summary.issue_date ?? "1900-01-01"} and total_amount = ${first.summary.total_amount ?? -1}))))
     limit 50`;
  const target: DupDoc = {
    id: doc.id,
    fileHash: doc.file_hash,
    documentType: doc.document_type,
    issuerName: first.summary.issuer_name,
    documentNumber: first.summary.document_number,
    issueDate: first.summary.issue_date,
    totalAmount: first.summary.total_amount,
    uploadedAt: doc.uploaded_at.toISOString(),
    filename: doc.filename,
  };
  const matches = findDuplicates(target, others.map((o) => ({
    id: o.id, fileHash: o.file_hash, documentType: o.document_type, issuerName: o.issuer_name, documentNumber: o.document_number,
    issueDate: o.issue_date, totalAmount: o.total_amount, uploadedAt: o.uploaded_at.toISOString(), filename: o.filename,
  })));
  const decided = await q<{ other_document_id: string; status: string }[]>`
    select other_document_id, status from duplicate_candidates where document_id = ${documentId} and organization_id = ${orgId}`;
  const decidedMap = new Map(decided.map((d) => [d.other_document_id, d.status]));
  const pending = matches.filter((m) => (decidedMap.get(m.otherId) ?? "pending") === "pending");

  const result = validateDocument({
    documentType: doc.document_type,
    fields: states,
    conflicts,
    context: latest?.output.context ?? EMPTY_CONTEXT,
    threshold: settings?.confidence_threshold ?? 0.8,
    duplicates: pending,
    accepted: Object.fromEntries(accepted.map((a) => [a.issue_key, a.sig])),
  });
  const payload = {
    fields: result.fieldStatuses.map((s) => ({ id: s.id, validation_status: s.status })),
    issues: result.issues.map((i) => ({ key: i.key, field_id: i.fieldId, type: i.type, severity: i.severity, reason: i.reason, detail: i.detail })),
    duplicates: matches.map((m) => ({ other_document_id: m.otherId, kind: m.kind, matched: m.matched })),
    summary: result.summary,
  };
  return { result, payload };
}

/** worker から：DB の所有者の接続で保存する */
export async function syncValidationAsOwner(q: Q, orgId: string, documentId: string): Promise<number | null> {
  const computed = await computeValidation(q, orgId, documentId);
  if (!computed) return null;
  const [row] = await q<{ n: number }[]>`select app_private.sync_validation(${orgId}, ${documentId}, ${q.json(computed.payload as never)}) n`;
  return row.n;
}

/** 利用者の操作のあと：ログイン利用者の接続（RLS 付き）で保存する。DB の関数が役割を確かめる */
export async function syncValidationAsUser(tx: TransactionSql, orgId: string, documentId: string): Promise<number | null> {
  const computed = await computeValidation(tx, orgId, documentId);
  if (!computed) return null;
  const [row] = await tx<{ n: number }[]>`select sync_validation(${documentId}, ${tx.json(computed.payload as never)}) n`;
  return row.n;
}
