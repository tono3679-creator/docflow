"use client";
/** 読み取りの情報（方法・信頼度・種別の判定の根拠）と、この書類の履歴 */
import type { DocumentDetail, HistoryRow } from "@/lib/data/documents";
import { AUDIT_ACTION_LABEL, REVIEW_ACTION_LABEL } from "@/lib/domain/labels";
import { displayValue } from "@/lib/extraction/normalize";
import { DOCUMENT_TYPE_LABELS } from "@/lib/extraction/schema";
import type { DocumentType } from "@/lib/extraction/types";
import { formatDateTimeFull } from "@/lib/format";
import { kindOf, labelOf, methodLabel } from "./model";

const OCR_PROVIDER: Record<string, string> = { tesseract: "Tesseract（このシステムのサーバー内）", "google-document-ai": "Google Document AI" };

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function ExtractionInfo({ detail }: { detail: DocumentDetail }) {
  const { doc, result, pages, job } = detail;
  const scores = doc.classification?.scores ?? {};
  const evidence = doc.classification?.evidence ?? [];
  return (
    <dl className="px-4 py-2 text-xs">
      <Item label="読み取り">{methodLabel(doc.extraction_method)}</Item>
      {result?.is_precomputed && <Item label="結果">事前に処理して保存した結果（デモ用）。アップロードした書類は、その場で読み取ります</Item>}
      {result?.ocr_provider && <Item label="OCR">{OCR_PROVIDER[result.ocr_provider] ?? result.ocr_provider}</Item>}
      {result?.model && <Item label="AI">{result.llm_provider ?? ""} {result.model}</Item>}
      {pages.some((p) => p.mean_confidence !== null) && (
        <Item label="OCR の平均信頼度">{pages.map((p) => (p.mean_confidence === null ? "—" : `${Math.round(p.mean_confidence * 100)}%`)).join(" / ")}</Item>
      )}
      <Item label="種別の判定">
        {DOCUMENT_TYPE_LABELS[(doc.document_type ?? "unknown") as DocumentType]}
        {doc.type_source === "user" && "（利用者が指定）"}
        {Object.keys(scores).length > 0 && (
          <span className="block text-muted-foreground">
            {Object.entries(scores).map(([k, v]) => `${DOCUMENT_TYPE_LABELS[k as DocumentType] ?? k} ${v}`).join("・")}
          </span>
        )}
        {evidence.length > 0 && <span className="block text-muted-foreground">根拠：{evidence.slice(0, 6).join("、")}</span>}
      </Item>
      <Item label="ページ">{doc.page_count}</Item>
      <Item label="ファイル">{doc.file_type.toUpperCase()}・{Math.max(1, Math.round(doc.file_size / 1024)).toLocaleString("ja-JP")}KB</Item>
      <Item label="アップロード">{formatDateTimeFull(doc.uploaded_at)}{doc.uploaded_by_name && `（${doc.uploaded_by_name}）`}</Item>
      {doc.processed_at && <Item label="読取完了">{formatDateTimeFull(doc.processed_at)}</Item>}
      {doc.confirmed_at && <Item label="確定">{formatDateTimeFull(doc.confirmed_at)}{doc.confirmed_by_name && `（${doc.confirmed_by_name}）`}</Item>}
      {job && job.attempts > 1 && <Item label="処理の回数">{job.attempts} / {job.max_attempts}</Item>}
      {(result?.notes ?? []).length > 0 && <Item label="メモ">{result!.notes.join("／")}</Item>}
    </dl>
  );
}

export function HistoryList({ rows, type }: { rows: HistoryRow[]; type: DocumentType | null }) {
  if (rows.length === 0) return <p className="px-4 py-3 text-xs text-muted-foreground">履歴はまだありません。</p>;
  return (
    <ol className="divide-y divide-border/60 text-xs" aria-label="この書類の履歴">
      {rows.map((r) => {
        const label = r.kind === "review" ? (REVIEW_ACTION_LABEL[r.action] ?? r.action) : (AUDIT_ACTION_LABEL[r.action] ?? r.action);
        const field = r.field_key ? labelOf(type, { field_key: r.field_key, line_index: r.line_index }) : r.line_index !== null ? `明細${r.line_index + 1}` : null;
        const kind = r.field_key ? kindOf(type, { field_key: r.field_key, line_index: r.line_index }) : undefined;
        const changed = r.action === "edit";
        return (
          <li key={r.id} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 px-4 py-1.5">
            <time className="tabular text-muted-foreground" dateTime={new Date(r.at).toISOString()}>{formatDateTimeFull(r.at)}</time>
            <div className="min-w-0">
              <span className="font-medium">{label}</span>
              {field && <span className="ml-1.5">{field}</span>}
              {changed && (
                <span className="ml-1.5 text-muted-foreground">
                  {displayValue(kind, r.before_value) || "（空）"} → <span className="text-foreground">{displayValue(kind, r.after_value) || "（空）"}</span>
                </span>
              )}
              {r.action === "change_type" && <span className="ml-1.5 text-muted-foreground">{DOCUMENT_TYPE_LABELS[(r.before_value ?? "unknown") as DocumentType]} → {DOCUMENT_TYPE_LABELS[(r.after_value ?? "unknown") as DocumentType]}</span>}
              {r.action === "duplicate_decision" && <span className="ml-1.5 text-muted-foreground">{r.after_value === "duplicate" ? "重複" : r.after_value === "not_duplicate" ? "重複ではない" : "未判断に戻す"}</span>}
              {r.reason && <span className="block text-muted-foreground">理由：{r.reason}</span>}
              <span className="ml-1.5 text-muted-foreground">{r.actor_name ?? "システム"}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
