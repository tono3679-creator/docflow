import "server-only";
/**
 * 読取の結果を保存する（worker から、DB の所有者の接続で。必ず organization_id を指定する）。
 *   ページの文字と座標 → document_pages
 *   AI・ルールの出力そのまま → extraction_results（書き換えない）
 *   項目 → document_fields（extracted_value＝読み取った値、value＝今の値。最初は同じ）
 *   明細の行の位置 → document_line_items
 * 読み直したときは、前の項目・明細を消して作り直す（確認・修正の記録 review_actions は残る）。
 */
import type { Sql, TransactionSql } from "postgres";
import { FIELD_DEFS, LINE_KEYS, isKnownType } from "@/lib/extraction/schema";
import type { AnalyzeResult, UsageEntry } from "@/lib/extraction/pipeline";
import type { DocumentType, PageText, Word } from "@/lib/extraction/types";
import { syncValidationAsOwner } from "./validation";

type Q = Sql | TransactionSql;

/** 単語を保存する形：[文字, x, y, w, h, 信頼度] */
export type StoredWord = [string, number, number, number, number, number | null];

const r5 = (n: number) => Math.round(n * 100000) / 100000;

export function packWords(words: Word[]): StoredWord[] {
  return words.map((w) => [w.text, r5(w.box.x), r5(w.box.y), r5(w.box.w), r5(w.box.h), w.conf === null ? null : Math.round(w.conf * 1000) / 1000]);
}

export function unpackWords(words: StoredWord[]): Word[] {
  return words.map(([text, x, y, w, h, conf]) => ({ text, box: { x, y, w, h }, conf }));
}

export type StoredPage = { page_number: number; width: number; height: number; text_source: "pdf_text" | "ocr" | "none"; ocr_engine: string | null; words: StoredWord[] };

export function toPageText(p: StoredPage): PageText {
  return { page: p.page_number, width: p.width, height: p.height, source: p.text_source, engine: p.ocr_engine, words: unpackWords(p.words) };
}

export async function savePages(q: Q, orgId: string, documentId: string, pages: PageText[]) {
  await q`delete from document_pages where document_id = ${documentId} and organization_id = ${orgId}`;
  for (const p of pages) {
    const confs = p.words.map((w) => w.conf).filter((c): c is number => c !== null);
    const mean = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
    const source = p.words.length === 0 ? "none" : p.source;
    await q`insert into document_pages (organization_id, document_id, page_number, width, height, text_source, ocr_engine, words, mean_confidence)
            values (${orgId}, ${documentId}, ${p.page}, ${p.width}, ${p.height}, ${source}, ${p.engine}, ${q.json(packWords(p.words) as never)},
                    ${mean === null ? null : Math.round(mean * 1000) / 1000})`;
  }
}

export type SaveInput = {
  orgId: string;
  documentId: string;
  jobId: string | null;
  pages: PageText[];
  analyzed: AnalyzeResult;
  forcedType: DocumentType | null;
  ocrProvider: string | null;
  durationMs: number;
  isPrecomputed?: boolean;
  /** 事前に処理した結果を入れるとき、処理した日時 */
  processedAt?: Date;
};

export async function saveExtraction(q: Q, input: SaveInput): Promise<{ openIssues: number | null }> {
  const { orgId, documentId, analyzed } = input;
  const out = analyzed.output;
  const type = out.documentType;
  const pageSource = new Map(input.pages.map((p) => [p.page, p.source]));

  await q`delete from document_fields where document_id = ${documentId} and organization_id = ${orgId}`;
  await q`delete from document_line_items where document_id = ${documentId} and organization_id = ${orgId}`;

  await q`insert into extraction_results (organization_id, document_id, job_id, method, ocr_provider, llm_provider, model, is_precomputed,
                                          document_type, classification, output, duration_ms, processed_at)
          values (${orgId}, ${documentId}, ${input.jobId}, ${analyzed.method}, ${input.ocrProvider}, ${analyzed.llm?.provider ?? null},
                  ${analyzed.llm?.model ?? null}, ${input.isPrecomputed ?? false}, ${type}, ${q.json(out.classification as never)},
                  ${q.json(out as never)}, ${input.durationMs}, ${input.processedAt ?? new Date()})`;

  for (const li of out.lineItems) {
    await q`insert into document_line_items (organization_id, document_id, line_index, page_number, bounding_box)
            values (${orgId}, ${documentId}, ${li.index}, ${li.page}, ${q.json(li.box as never)})`;
  }

  // 項目：書類種別の項目はすべて作る（読めなかった項目も「未取得」として確認できるように）
  type Row = { key: string; line: number | null; value: string | null; page: number | null; box: unknown; conf: number | null; text: string | null; source: string };
  const rows: Row[] = [];
  const byRef = new Map(out.fields.map((f) => [`${f.line ?? "h"}:${f.key}`, f]));
  const docSource = analyzed.method.startsWith("ocr") ? "ocr" : "pdf_text";
  const toRow = (key: string, line: number | null): Row => {
    const f = byRef.get(`${line ?? "h"}:${key}`);
    const src = f?.value != null ? f.source : null;
    return {
      key,
      line,
      value: f?.value ?? null,
      page: src?.page ?? null,
      box: src?.box ?? null,
      conf: src?.conf ?? null,
      text: src?.text?.slice(0, 1000) ?? null,
      source: src ? (pageSource.get(src.page) === "ocr" ? "ocr" : "pdf_text") : docSource,
    };
  };
  if (isKnownType(type)) {
    for (const def of FIELD_DEFS[type]) {
      const row = toRow(def.key, null);
      if (def.show === "always" || row.value !== null) rows.push(row);
    }
    const lineIndexes = [...new Set(out.fields.filter((f) => f.line !== null).map((f) => f.line as number))].sort((a, b) => a - b);
    for (const line of lineIndexes) for (const key of LINE_KEYS) rows.push(toRow(key, line));
  }
  for (const r of rows) {
    const value = r.value === null ? null : r.value.slice(0, 1000);
    await q`insert into document_fields (organization_id, document_id, line_index, field_key, extracted_value, value, page_number, bounding_box,
                                         confidence, source_text, source)
            values (${orgId}, ${documentId}, ${r.line}, ${r.key}, ${value}, ${value}, ${r.box ? r.page : null},
                    ${r.box ? q.json(r.box as never) : null}, ${r.conf === null ? null : Math.round(r.conf * 1000) / 1000}, ${r.text}, ${r.source})`;
  }

  await q`update documents set
            document_type = ${type},
            type_source = ${input.forcedType ? "user" : "ai"},
            classification = ${q.json(out.classification as never)},
            extraction_method = ${analyzed.method},
            page_count = ${Math.max(1, input.pages.length)},
            processed_at = ${input.processedAt ?? new Date()},
            error_message = null,
            status = 'needs_review',
            version = version + 1
          where id = ${documentId} and organization_id = ${orgId}`;

  const openIssues = await syncValidationAsOwner(q, orgId, documentId);
  return { openIssues };
}

export async function logUsage(q: Q, orgId: string, documentId: string | null, usage: UsageEntry[], at?: Date) {
  for (const u of usage) {
    await q`insert into ai_usage_logs (organization_id, document_id, kind, provider, model, pages, input_tokens, output_tokens, duration_ms, success, error, created_at)
            values (${orgId}, ${documentId}, ${u.kind}, ${u.provider}, ${u.model}, ${u.pages}, ${u.inputTokens}, ${u.outputTokens}, ${u.durationMs},
                    ${u.success}, ${u.error}, ${at ?? new Date()})`;
  }
}
