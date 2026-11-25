/**
 * 確認画面の計算（画面の部品から切り離した、テストできる純粋な関数）。
 *   - 入力中の値・確認の切り替えは保存するまで画面の中に持ち、保存のときに変更の一覧にする
 *   - 値を直しただけでは確認済みにしない（DB の関数と同じ規則。確認を押したときだけ確認済み）
 *   - 原本の印の色：黄＝要確認、赤＝不整合、緑＝確認済み（表示を選んだとき）、青＝選択中（表示側で付ける）
 */
import { editableValue, type AnyKind } from "@/lib/extraction/normalize";
import { FIELD_DEFS, fieldDef, isKnownType, lineFieldDef, LINE_FIELDS } from "@/lib/extraction/schema";
import type { DocumentType } from "@/lib/extraction/types";

export type Box = { x: number; y: number; w: number; h: number };

export type ReviewField = {
  id: string;
  field_key: string;
  line_index: number | null;
  extracted_value: string | null;
  value: string | null;
  page_number: number | null;
  bounding_box: Box | null;
  confidence: number | null;
  source: "pdf_text" | "ocr" | "user";
  validation_status: "ok" | "needs_review" | "inconsistent" | "missing";
  review_status: "unreviewed" | "confirmed";
};

export type Draft = { values: Record<string, string>; confirms: Record<string, boolean> };
export const EMPTY_DRAFT: Draft = { values: {}, confirms: {} };

export type SetChange = { op: "set"; fieldId: string; value?: string | null; confirm?: boolean; unconfirm?: boolean };

export function kindOf(type: DocumentType | null, f: Pick<ReviewField, "field_key" | "line_index">): AnyKind | undefined {
  return f.line_index === null ? fieldDef(type, f.field_key)?.kind : lineFieldDef(f.field_key)?.kind;
}

export function labelOf(type: DocumentType | null, f: Pick<ReviewField, "field_key" | "line_index">): string {
  if (f.line_index === null) return fieldDef(type, f.field_key)?.label ?? f.field_key;
  return `明細${f.line_index + 1} ${lineFieldDef(f.field_key)?.label ?? f.field_key}`;
}

/** 入力欄の値が、保存されている値から変わっているか（「1,200」と「1200」のような書き方の違いは変更にしない） */
export function isValueEdited(type: DocumentType | null, f: ReviewField, draft: Draft): boolean {
  const d = draft.values[f.id];
  if (d === undefined) return false;
  return d.trim() !== editableValue(kindOf(type, f), f.value).trim();
}

/** 画面に出す「確認済み」（保存前の切り替えを含む。値を直したら、確認を押し直すまで未確認） */
export function effectiveConfirmed(type: DocumentType | null, f: ReviewField, draft: Draft): boolean {
  if (f.id in draft.confirms) return draft.confirms[f.id];
  if (isValueEdited(type, f, draft)) return false;
  return f.review_status === "confirmed";
}

/** 保存する変更の一覧（変わっていない項目は送らない） */
export function buildChanges(type: DocumentType | null, fields: ReviewField[], draft: Draft): SetChange[] {
  const out: SetChange[] = [];
  for (const f of fields) {
    const edited = isValueEdited(type, f, draft);
    const want = draft.confirms[f.id];
    const isConfirmed = f.review_status === "confirmed";
    const change: SetChange = { op: "set", fieldId: f.id };
    let changed = false;
    if (edited) {
      const v = draft.values[f.id].trim();
      change.value = v === "" ? null : v;
      changed = true;
    }
    if (want === true && (!isConfirmed || edited)) {
      change.confirm = true;
      changed = true;
    } else if (want === false && isConfirmed && !edited) {
      // 値を直したときは DB の関数が未確認に戻すので、取り消しの指定は要らない
      change.unconfirm = true;
      changed = true;
    }
    if (changed) out.push(change);
  }
  return out;
}

export type Tone = "warning" | "danger" | "confirmed" | "none";

/** 原本の印の色。正常な項目は印を出さない（押せば選べる透明な枠だけ置く） */
export function toneOf(f: Pick<ReviewField, "validation_status">, confirmed: boolean, showConfirmed: boolean): Tone {
  if (f.validation_status === "inconsistent") return "danger";
  if (confirmed) return showConfirmed ? "confirmed" : "none";
  if (f.validation_status === "needs_review") return "warning";
  return "none";
}

/** 見出しの項目を、書類種別の定義の順に並べる */
export function headerFields(type: DocumentType | null, fields: ReviewField[]): ReviewField[] {
  const defs = isKnownType(type) ? FIELD_DEFS[type] : [];
  const order = new Map(defs.map((d, i) => [d.key, i]));
  return fields.filter((f) => f.line_index === null).sort((a, b) => (order.get(a.field_key) ?? 999) - (order.get(b.field_key) ?? 999));
}

export type LineGroup = { line: number; cells: Record<string, ReviewField | undefined> };

export function lineGroups(fields: ReviewField[]): LineGroup[] {
  const map = new Map<number, LineGroup>();
  for (const f of fields) {
    if (f.line_index === null) continue;
    const g = map.get(f.line_index) ?? { line: f.line_index, cells: {} };
    g.cells[f.field_key] = f;
    map.set(f.line_index, g);
  }
  return [...map.values()].sort((a, b) => a.line - b.line);
}

export const LINE_COLUMNS = LINE_FIELDS;

/** 読み取りの方法の表示（例：pdf_text+rules → PDF の文字情報＋規則で抽出） */
export function methodLabel(method: string | null | undefined): string {
  if (!method) return "—";
  const [src, ext] = method.split("+");
  const s = src === "ocr" ? "OCR" : src === "pdf_text" ? "PDF の文字情報" : src;
  const e = ext === "llm" ? "AI で抽出" : ext === "rules" ? "規則で抽出" : (ext ?? "");
  return e ? `${s}＋${e}` : s;
}

/** 選んだ項目に原本の印を出せないときの説明（架空の位置に印を出さない） */
export function noBoxNotice(type: DocumentType | null, f: ReviewField | null | undefined): string | null {
  if (!f || (f.bounding_box && f.page_number !== null)) return null;
  const label = labelOf(type, f);
  if (f.value === null) return `「${label}」は原本から読み取れていません。`;
  if (f.extracted_value === null && f.source === "user") return `「${label}」は手入力の値です（原本の位置はありません）。`;
  return `「${label}」は原本の位置を特定できないため、印を付けていません。`;
}
