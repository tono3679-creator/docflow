/**
 * 項目の値をそろえる（読取の結果・利用者の入力の両方に使う）。解釈できなければ元の文字のまま返す
 * （値を作り替えない。形式の確認は src/lib/validation/validate.ts が行う）。
 */
import { formatDate, formatDecimal, formatYen, isIntegerString, milliToString, parseDecimalMilli, parseJpDate, parseRegistrationNumber, parseTaxRate, parseYen } from "../validation/values";
import type { FieldKind, LineKind } from "./schema";
import { TAX_RATE_LABELS } from "./schema";
import { normalizeText } from "./text";

export type AnyKind = FieldKind | LineKind;

export function normalizeValue(kind: AnyKind | undefined, raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = kind === "multiline" ? raw.split(/\r?\n/).map((l) => normalizeText(l)).filter(Boolean).join("\n") : normalizeText(raw);
  if (!text) return null;
  switch (kind) {
    case "date":
      return parseJpDate(text) ?? text;
    case "amount": {
      const v = parseYen(text);
      return v === null ? text : String(v);
    }
    case "quantity":
    case "unit_price": {
      const v = parseDecimalMilli(text);
      return v === null ? text : milliToString(v);
    }
    case "reg_no":
      return parseRegistrationNumber(text) ?? text;
    case "tax_rate":
      return parseTaxRate(text) ?? text;
    default:
      return text.slice(0, 1000);
  }
}

/** 画面の表示用 */
export function displayValue(kind: AnyKind | undefined, value: string | null): string {
  if (value == null) return "";
  switch (kind) {
    case "date":
      return formatDate(value);
    case "amount":
      return isIntegerString(value) ? formatYen(Number(value)) : value;
    case "quantity":
      return formatDecimal(value);
    case "unit_price":
      return parseDecimalMilli(value) === null ? value : `¥${formatDecimal(value)}`;
    case "tax_rate":
      return TAX_RATE_LABELS[value] ?? value;
    default:
      return value;
  }
}

/** 入力欄に入れる値（記号を付けず、編集しやすい形） */
export function editableValue(kind: AnyKind | undefined, value: string | null): string {
  if (value == null) return "";
  if (kind === "date") return formatDate(value);
  if (kind === "amount" && isIntegerString(value)) return Number(value).toLocaleString("ja-JP");
  if (kind === "unit_price" || kind === "quantity") return parseDecimalMilli(value) === null ? value : formatDecimal(value);
  return value;
}
