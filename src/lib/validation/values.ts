/**
 * 値の解釈（OCR・PDF の文字・利用者の入力に共通）。
 * 金額は円の整数、数量・単価は 1/1000 単位の BigInt で扱い、浮動小数点は使わない。
 * 解釈できない文字は null を返す（推測で直さない。例：OCR の「1l0」を「110」にしない）。
 */
import { normalizeChars } from "../extraction/text";

/** 金額（円）。¥110,800 / 110,800円 / △500 / -500 / ¥12,000- など */
export function parseYen(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = normalizeChars(String(input)).replace(/\s+/g, "");
  if (!s) return null;
  let negative = false;
  if (/^[△▲\-−]/.test(s)) {
    negative = true;
    s = s.slice(1);
  }
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^¥/, "");
  if (/^[△▲\-−]/.test(s)) {
    negative = true;
    s = s.slice(1);
  }
  s = s.replace(/\((税込|税抜|税込み)\)$/, "").replace(/(円|-|―|也)+$/, "");
  // OCR が桁区切りの「,」を「.」と読んだもの（3桁ずつ）も金額として読む（円に小数は無い）
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ",");
  if (!/^\d{1,3}(,\d{3})*$|^\d+$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isSafeInteger(n)) return null;
  return negative ? -n : n;
}

export function formatYen(n: number | null | undefined): string {
  if (n == null) return "";
  return `${n < 0 ? "-" : ""}¥${Math.abs(n).toLocaleString("ja-JP")}`;
}

/** 小数（数量・単価）。1/1000 単位の整数（BigInt）にする。12 / 2.5 / 1,200 / 1,234.5 */
export function parseDecimalMilli(input: string | null | undefined): bigint | null {
  if (input == null) return null;
  let s = normalizeChars(String(input)).replace(/\s+/g, "").replace(/^¥/, "").replace(/円$/, "");
  if (!s) return null;
  let negative = false;
  if (/^[△▲\-−]/.test(s)) {
    negative = true;
    s = s.slice(1);
  }
  const m = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const int = BigInt(m[1].replace(/,/g, ""));
  const frac = BigInt((m[2] ?? "").padEnd(3, "0"));
  const v = int * 1000n + frac;
  return negative ? -v : v;
}

export function milliToString(v: bigint): string {
  const negative = v < 0n;
  const a = negative ? -v : v;
  const int = a / 1000n;
  const frac = (a % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** 数量の表示：12 / 2.5 */
export function formatDecimal(input: string | null | undefined): string {
  const v = parseDecimalMilli(input);
  if (v === null) return input ?? "";
  const s = milliToString(v);
  const [i, f] = s.split(".");
  return `${Number(i).toLocaleString("ja-JP")}${f ? `.${f}` : ""}`;
}

/** 日付。2026年11月20日 / 2026/11/20 / 2026-11-20 / 2026.11.20 / 令和8年11月20日 / R8.11.20 → YYYY-MM-DD */
export function parseJpDate(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = normalizeChars(String(input)).replace(/\s+/g, "");
  let y: number, mo: number, d: number;
  let m = /^(\d{4})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?$/.exec(s);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = /^(令和|R|r|平成|H|h)(\d{1,2}|元)[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?$/.exec(s))) {
    const n = m[2] === "元" ? 1 : Number(m[2]);
    const base = /令和|R|r/.test(m[1]) ? 2018 : 1988;
    [y, mo, d] = [base + n, Number(m[3]), Number(m[4])];
  } else {
    return null;
  }
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const isIsoDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseJpDate(s.replace(/-/g, "/")) === s;

export function formatDate(iso: string | null | undefined): string {
  if (!isIsoDate(iso)) return iso ?? "";
  return iso.replace(/-/g, "/");
}

/** 適格請求書発行事業者の登録番号（T＋13桁） */
export function parseRegistrationNumber(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = normalizeChars(String(input)).replace(/[\s\-‐]/g, "").toUpperCase();
  return /^T\d{13}$/.test(s) ? s : null;
}

/** 税率：10 / 8 / 0（非課税・対象外）。※・軽 は軽減税率（8%）の印として扱う */
export function parseTaxRate(input: string | null | undefined): "10" | "8" | "0" | null {
  if (input == null) return null;
  const s = normalizeChars(String(input)).replace(/\s+/g, "");
  if (!s) return null;
  if (/^10%?$|10%/.test(s)) return "10";
  if (/^8%?$|8%|^※$|軽減|^軽$|^\*$/.test(s)) return "8";
  if (/^0%?$|非課税|対象外|不課税/.test(s)) return "0";
  return null;
}

export const isIntegerString = (s: string | null | undefined): boolean => !!s && /^-?\d+$/.test(s) && Number.isSafeInteger(Number(s));
