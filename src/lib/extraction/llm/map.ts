/**
 * LLM の結果を項目に直す。値は書類の文字に対応付け（grounding）する。
 *   - 根拠の文字が書類に無い・根拠と値が食い違う → 値を使わない（AI の推測・書き換えで項目を埋めない）
 *   - 根拠の文字が書類の複数の場所にある → 値は使うが位置は付けない（画面で「原本の位置を特定できません」→ 要確認）
 */
import { countOccurrences, groundText } from "../grounding";
import type { LayoutPage } from "../layout";
import { normalizeValue, type AnyKind } from "../normalize";
import { FIELD_DEFS, LINE_FIELDS, isKnownType, type KnownType } from "../schema";
import { compactKey } from "../text";
import type { ExtractedField, LineItemBox, SourceRef } from "../types";
import { union } from "../geometry";
import type { LlmOutputT } from "./prompt";

type V = { value: string | null; source_text: string | null; line_ids: string[] };

function consistent(kind: AnyKind | undefined, value: string, source: SourceRef): boolean {
  const fromSource = normalizeValue(kind, source.text);
  if (kind === "date" || kind === "amount" || kind === "quantity" || kind === "unit_price" || kind === "reg_no") return fromSource === value;
  const a = compactKey(value);
  const b = compactKey(source.text);
  return a.length > 0 && (b.includes(a) || a.includes(b));
}

/** 使わなかった値（書類に根拠が無い・根拠と食い違う）の記録 */
export type Dropped = { key: string; line: number | null; reason: "not_in_document" | "differs_from_source" };

function toField(pages: LayoutPage[], key: string, line: number | null, kind: AnyKind | undefined, v: V | undefined, dropped: Dropped[]): ExtractedField {
  const empty: ExtractedField = { key, line, value: null, source: null };
  if (!v || v.value === null || !String(v.value).trim()) return empty;
  const value = normalizeValue(kind, v.value);
  if (value === null) return empty;
  const ref = groundText(pages, v.source_text, v.line_ids);
  if (ref) {
    if (consistent(kind, value, ref)) return { key, line, value, source: ref };
    dropped.push({ key, line, reason: "differs_from_source" });
    return empty;
  }
  if (countOccurrences(pages, v.source_text) === 0) {
    dropped.push({ key, line, reason: "not_in_document" });
    return empty;
  }
  // 同じ文字が複数の場所にある：値が根拠と合っていれば使う（位置は付けない）
  if (!consistent(kind, value, { page: 0, box: { x: 0, y: 0, w: 0, h: 0 }, text: v.source_text ?? "", conf: null })) {
    dropped.push({ key, line, reason: "differs_from_source" });
    return empty;
  }
  return { key, line, value, source: null };
}

export function mapLlmOutput(pages: LayoutPage[], output: LlmOutputT, type: KnownType): { fields: ExtractedField[]; lineItems: LineItemBox[]; dropped: Dropped[] } {
  const fields: ExtractedField[] = [];
  const dropped: Dropped[] = [];
  const defs = isKnownType(type) ? FIELD_DEFS[type] : [];
  for (const def of defs) {
    const found = output.fields.filter((f) => f.key === def.key && f.value !== null);
    const first = toField(pages, def.key, null, def.kind, found[0], dropped);
    const others = found.slice(1).map((f) => toField(pages, def.key, null, def.kind, f, dropped)).filter((f) => f.value !== null && f.value !== first.value);
    if (others.length > 0) first.conflicts = others.map((o) => ({ value: o.value as string, source: o.source }));
    fields.push(first);
  }
  const lineItems: LineItemBox[] = [];
  output.line_items.forEach((item, index) => {
    const row = LINE_FIELDS.map((lf) => toField(pages, lf.key, index, lf.kind, item[lf.key as keyof typeof item], dropped));
    fields.push(...row);
    const sources = row.map((f) => f.source).filter((s): s is SourceRef => !!s);
    const page = sources[0]?.page;
    const box = page ? union(sources.filter((s) => s.page === page).map((s) => s.box)) : null;
    if (page && box) lineItems.push({ index, page, box });
  });
  return { fields, lineItems, dropped };
}
