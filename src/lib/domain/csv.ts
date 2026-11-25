/**
 * CSV の出力（純粋関数）。
 *   出力：UTF-8（BOM 付き・Excel で文字化けしない）、CRLF、必要なときだけ "" で囲む。
 *   数式として解釈される値（= + - @ で始まる文字列）は先頭に ' を付けて無害化する（CSV インジェクション対策）。
 */
export type CsvValue = string | number | boolean | null | undefined;

const FORMULA = /^[=+\-@\t\r]/;

export function escapeCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  const lines = [header, ...rows].map((r) => r.map(escapeCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
