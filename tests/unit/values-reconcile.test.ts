/** 値の解釈と金額の照合（浮動小数点を使わない・解釈できない値を推測で直さない・計算方式が不明なら検証不能） */
import { describe, expect, it } from "vitest";
import { normalizeValue } from "@/lib/extraction/normalize";
import { reconcile, taxCandidates, type ReconcileInput } from "@/lib/validation/reconcile";
import { isIsoDate, parseDecimalMilli, parseJpDate, parseRegistrationNumber, parseTaxRate, parseYen } from "@/lib/validation/values";

describe("値の解釈", () => {
  it("金額：記号・全角・カンマ・円・マイナスの書き方", () => {
    expect(parseYen("¥110,800")).toBe(110800);
    expect(parseYen("１１０，８００円")).toBe(110800);
    expect(parseYen("￥12,000-")).toBe(12000);
    expect(parseYen("△500")).toBe(-500);
    expect(parseYen("(1,200)")).toBe(-1200);
  });
  it("金額：OCR の誤読らしい文字は直さずに null（推測しない）", () => {
    expect(parseYen("1l0,800")).toBeNull();
    expect(parseYen("11,08")).toBeNull();
    expect(parseYen("")).toBeNull();
  });
  it("数量・単価は 1/1000 単位の整数で扱う", () => {
    expect(parseDecimalMilli("2.5")).toBe(2500n);
    expect(parseDecimalMilli("1,234.5")).toBe(1234500n);
    expect(parseDecimalMilli("0.001")).toBe(1n);
    expect(parseDecimalMilli("abc")).toBeNull();
  });
  it("日付：和暦・スラッシュ・漢字の書き方。存在しない日付は null", () => {
    expect(parseJpDate("2026年11月1日")).toBe("2026-11-01");
    expect(parseJpDate("2026/11/1")).toBe("2026-11-01");
    expect(parseJpDate("令和8年11月1日")).toBe("2026-11-01");
    expect(parseJpDate("2026/02/30")).toBeNull();
    expect(isIsoDate("2026-02-30")).toBe(false);
  });
  it("登録番号は T＋13桁", () => {
    expect(parseRegistrationNumber("T1234567890123")).toBe("T1234567890123");
    expect(parseRegistrationNumber("T 1234-5678-9012-3")).toBe("T1234567890123");
    expect(parseRegistrationNumber("T123")).toBeNull();
  });
  it("税率", () => {
    expect(parseTaxRate("10%")).toBe("10");
    expect(parseTaxRate("８％")).toBe("8");
    expect(parseTaxRate("※軽減")).toBe("8");
  });
  it("入力値をそろえる（解釈できなければ入力のまま残し、検証で知らせる）", () => {
    expect(normalizeValue("amount", "¥1,200")).toBe("1200");
    expect(normalizeValue("date", "2026/11/1")).toBe("2026-11-01");
    expect(normalizeValue("amount", "1l0")).toBe("1l0");
    expect(normalizeValue("quantity", "2.50")).toBe("2.5");
    expect(normalizeValue("text", "   ")).toBeNull();
  });
});

const base = (over: Partial<ReconcileInput>): ReconcileInput => ({
  subtotal: null, taxAmount: null, total: null, discount: null, shipping: null,
  tax10Base: null, tax10: null, tax8Base: null, tax8: null, lines: [],
  taxIncluded: null, rounding: null, statedRates: [], hasReducedMarker: false, ...over,
});
const line = (index: number, q: string, p: string, amount: number, taxRate: "10" | "8" | "0" | null = null) => ({
  index, quantityMilli: parseDecimalMilli(q), unitPriceMilli: parseDecimalMilli(p), amount, taxRate,
});
const status = (checks: ReturnType<typeof reconcile>, id: string) => checks.find((c) => c.id === id)?.status;

describe("金額の照合", () => {
  it("税抜・10% の請求書：明細・小計・消費税・合計がすべて一致", () => {
    const c = reconcile(base({ lines: [line(0, "3", "4000", 12000), line(1, "1", "120000", 120000)], subtotal: 132000, taxAmount: 13200, total: 145200, statedRates: ["10"] }));
    expect(c.map((x) => x.status)).toEqual(["match", "match", "match", "match", "match"]);
  });
  it("数量×単価の誤りは、その明細だけ不一致", () => {
    const c = reconcile(base({ lines: [line(0, "3", "4000", 12500)], subtotal: 12500, taxAmount: 1250, total: 13750, statedRates: ["10"] }));
    expect(status(c, "line.0")).toBe("mismatch");
    expect(status(c, "subtotal")).toBe("match");
  });
  it("小数の数量・単価（2.5 × 1,234.5）の端数は、切り捨て・四捨五入・切り上げのどれかに合えば一致", () => {
    const c = reconcile(base({ lines: [line(0, "2.5", "1234.5", 3086)] }));
    expect(status(c, "line.0")).toBe("match");
    const c2 = reconcile(base({ lines: [line(0, "2.5", "1234.5", 3087)] }));
    expect(status(c2, "line.0")).toBe("match");
    const c3 = reconcile(base({ lines: [line(0, "2.5", "1234.5", 3090)] }));
    expect(status(c3, "line.0")).toBe("mismatch");
  });
  it("端数処理が書かれていれば、その方式だけで判定する", () => {
    expect(taxCandidates(12345, 10, false, "floor")).toEqual([1234]);
    expect(taxCandidates(12345, 10, false, null)).toEqual([1234, 1235]);
    expect(taxCandidates(11000, 10, true, "floor")).toEqual([1000]);
  });
  it("軽減税率（8%と10%）：税率ごとに照合し、合計も確かめる", () => {
    const c = reconcile(base({ subtotal: 30000, tax10Base: 20000, tax10: 2000, tax8Base: 10000, tax8: 800, taxAmount: 2800, total: 32800, hasReducedMarker: true }));
    expect(status(c, "tax.10")).toBe("match");
    expect(status(c, "tax.8")).toBe("match");
    expect(status(c, "total")).toBe("match");
    const bad = reconcile(base({ subtotal: 30000, tax10Base: 20000, tax10: 2000, tax8Base: 10000, tax8: 1000, taxAmount: 3000, total: 33000, hasReducedMarker: true }));
    expect(status(bad, "tax.8")).toBe("mismatch");
  });
  it("税率の内訳が分からない（軽減税率の印があるのに内訳なし）なら、不一致と断定せず検証不能", () => {
    const c = reconcile(base({ subtotal: 30000, taxAmount: 2600, total: 32600, hasReducedMarker: true }));
    expect(status(c, "tax")).toBe("unverifiable");
  });
  it("税込（内税）の書き方：合計は小計と同じ", () => {
    const c = reconcile(base({ subtotal: 11000, taxAmount: 1000, total: 11000, taxIncluded: true, statedRates: ["10"] }));
    expect(status(c, "tax")).toBe("match");
    expect(status(c, "total")).toBe("match");
  });
  it("合計の誤りは不一致", () => {
    const c = reconcile(base({ subtotal: 132000, taxAmount: 13200, total: 145000, statedRates: ["10"] }));
    expect(status(c, "total")).toBe("mismatch");
  });
  it("値引き・送料の書き方を認める", () => {
    const c = reconcile(base({ lines: [line(0, "1", "10000", 10000)], discount: -1000, shipping: 500, subtotal: 9500, taxAmount: 950, total: 10450, statedRates: ["10"] }));
    expect(status(c, "subtotal")).toBe("match");
    expect(status(c, "total")).toBe("match");
  });
  it("値が変わると sig も変わる（承認したあとに値を直したら、もう一度確認が要る）", () => {
    const a = reconcile(base({ subtotal: 100, taxAmount: 10, total: 999, statedRates: ["10"] })).find((x) => x.id === "total")!;
    const b = reconcile(base({ subtotal: 100, taxAmount: 10, total: 998, statedRates: ["10"] })).find((x) => x.id === "total")!;
    expect(a.sig).not.toBe(b.sig);
  });
});
