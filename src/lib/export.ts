import "server-only";
/**
 * 出力（Excel・CSV）。会計ソフト固有の形式ではなく、DocFlow の標準の列で出力する。
 *   - 書類種別ごとに列を分ける（請求書・領収書・納品書）。明細は別のシート（CSV は別ファイル）
 *   - 値は今の値（確定済みの書類は確定した値）。金額は数値、日付は YYYY-MM-DD
 *   - 先頭が = + - @ の文字は ' を付けて数式として扱われないようにする（CSV と同じ規則を Excel にも適用）
 *   - Excel：見出しの行を固定し、フィルターを付ける
 */
import ExcelJS from "exceljs";
import type { Tx } from "@/lib/db";
import { escapeCell, toCsv, type CsvValue } from "@/lib/domain/csv";
import { DOCUMENT_STATUS_LABEL, type DocumentStatus } from "@/lib/domain/labels";
import { DOCUMENT_TYPE_LABELS, FIELD_DEFS, LINE_FIELDS, NUMBER_KEY, TAX_RATE_LABELS, isKnownType, type KnownType } from "@/lib/extraction/schema";
import type { DocumentType } from "@/lib/extraction/types";
import { isIntegerString, parseDecimalMilli } from "@/lib/validation/values";

export type ExportTarget = KnownType | "lines";
export const EXPORT_TARGET_LABEL: Record<ExportTarget, string> = {
  invoice: "請求書",
  receipt: "領収書",
  delivery_note: "納品書",
  lines: "明細",
};

type Doc = {
  id: string;
  filename: string;
  document_type: string | null;
  status: DocumentStatus;
  confirmed_at: Date | null;
  confirmed_by_name: string | null;
};
type Field = { document_id: string; field_key: string; line_index: number | null; value: string | null; confirmed_value: string | null };

export type ExportData = { docs: Doc[]; fields: Field[] };

export async function loadExportData(tx: Tx, ids: string[]): Promise<ExportData> {
  const docs = await tx<Doc[]>`
    select d.id, d.filename, d.document_type, d.status, d.confirmed_at, p.display_name confirmed_by_name
      from documents d left join profiles p on p.id = d.confirmed_by
     where d.id = any(${ids}::uuid[]) order by d.issue_date nulls last, d.uploaded_at`;
  const fields = await tx<Field[]>`
    select document_id, field_key, line_index, value, confirmed_value from document_fields where document_id = any(${ids}::uuid[])`;
  return { docs, fields };
}

const jst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function cellValue(kind: string | undefined, v: string | null): CsvValue {
  if (v === null || v === "") return null;
  if (kind === "amount" && isIntegerString(v)) return Number(v);
  if ((kind === "quantity" || kind === "unit_price") && parseDecimalMilli(v) !== null) return Number(v);
  if (kind === "tax_rate") return TAX_RATE_LABELS[v] ?? v;
  return v;
}

export type Sheet = { name: string; header: string[]; rows: CsvValue[][] };

export function buildSheets(data: ExportData, targets: ExportTarget[]): Sheet[] {
  const byDoc = new Map<string, Field[]>();
  for (const f of data.fields) {
    const list = byDoc.get(f.document_id) ?? [];
    list.push(f);
    byDoc.set(f.document_id, list);
  }
  const val = (f: Field, doc: Doc) => (doc.status === "confirmed" ? f.confirmed_value ?? f.value : f.value);
  const sheets: Sheet[] = [];
  for (const target of targets) {
    if (target === "lines") {
      const header = ["書類ID", "ファイル名", "書類種別", "書類番号", "発行元", "状態", "行", ...LINE_FIELDS.map((f) => f.label)];
      const rows: CsvValue[][] = [];
      for (const doc of data.docs) {
        const fields = byDoc.get(doc.id) ?? [];
        const head = (key: string) => {
          const f = fields.find((x) => x.line_index === null && x.field_key === key);
          return f ? val(f, doc) : null;
        };
        const number = isKnownType(doc.document_type) ? head(NUMBER_KEY[doc.document_type]) : null;
        const lines = [...new Set(fields.filter((f) => f.line_index !== null).map((f) => f.line_index as number))].sort((a, b) => a - b);
        lines.forEach((line, i) => {
          const get = (key: string) => {
            const f = fields.find((x) => x.line_index === line && x.field_key === key);
            return f ? val(f, doc) : null;
          };
          rows.push([doc.id, doc.filename, DOCUMENT_TYPE_LABELS[(doc.document_type ?? "unknown") as DocumentType], number, head("issuer_name"),
            DOCUMENT_STATUS_LABEL[doc.status], i + 1, ...LINE_FIELDS.map((lf) => cellValue(lf.kind, get(lf.key)))]);
        });
      }
      sheets.push({ name: EXPORT_TARGET_LABEL.lines, header, rows });
      continue;
    }
    const defs = FIELD_DEFS[target];
    const header = ["書類ID", "ファイル名", "状態", ...defs.map((d) => d.label), "明細数", "確定日時", "確定者"];
    const rows: CsvValue[][] = [];
    for (const doc of data.docs.filter((d) => d.document_type === target)) {
      const fields = byDoc.get(doc.id) ?? [];
      const lineCount = new Set(fields.filter((f) => f.line_index !== null).map((f) => f.line_index)).size;
      rows.push([
        doc.id, doc.filename, DOCUMENT_STATUS_LABEL[doc.status],
        ...defs.map((d) => {
          const f = fields.find((x) => x.line_index === null && x.field_key === d.key);
          return cellValue(d.kind, f ? val(f, doc) : null);
        }),
        lineCount,
        doc.confirmed_at ? jst.format(doc.confirmed_at) : null,
        doc.confirmed_by_name,
      ]);
    }
    sheets.push({ name: EXPORT_TARGET_LABEL[target], header, rows });
  }
  return sheets;
}

export function sheetToCsv(sheet: Sheet): string {
  return toCsv(sheet.header, sheet.rows);
}

/** 数式として解釈される文字を無害化した値（Excel 用。数値・空はそのまま） */
function safeExcelValue(v: CsvValue): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return v;
}

export async function sheetsToXlsx(sheets: Sheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "DocFlow";
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(s.header);
    for (const r of s.rows) ws.addRow(r.map(safeExcelValue));
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F4F5" } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, s.rows.length + 1), column: s.header.length } };
    s.header.forEach((h, i) => {
      const col = ws.getColumn(i + 1);
      const longest = Math.max(h.length * 2, ...s.rows.slice(0, 200).map((r) => String(r[i] ?? "").length * 1.6));
      col.width = Math.min(48, Math.max(8, Math.round(longest) + 2));
      if (/金額|小計|消費税|合計|対象|値引き|送料/.test(h)) col.numFmt = "#,##0";
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** テスト用：CSV のセルの無害化をそのまま公開 */
export const escapeCsvCell = escapeCell;
