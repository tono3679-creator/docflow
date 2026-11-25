/**
 * OCR のマスごとの読み直し（src/lib/extraction/ocr/refine.ts）。
 * 画像の切り出しと OCR の実行は別（tesseract.ts）なので、ここでは「どこを読み直すか」と「結果をどう使うか」を確かめる。
 */
import { describe, expect, it } from "vitest";
import { AGREE_CONF, applyReads, DISAGREE_CONF, planReads, type ReadJob, type ReadOut } from "@/lib/extraction/ocr/refine";
import { analyzePages } from "@/lib/extraction/pipeline";
import type { PageText, Word } from "@/lib/extraction/types";

const w = (text: string, x: number, y: number, conf = 0.95): Word => ({ text, box: { x, y, w: 0.014 * text.length, h: 0.02 }, conf });
const page = (words: Word[]): PageText => ({ page: 1, width: 1000, height: 1400, source: "ocr", engine: "test", words });

// 明細の表：数量が空・単価が「④⑧,.000」と崩れている・小計の自信が低い
const HEADER = [w("請求書", 0.45, 0.05), w("品名", 0.1, 0.3), w("数量", 0.5, 0.3), w("単位", 0.58, 0.3), w("単価", 0.72, 0.3), w("金額", 0.88, 0.3)];
const base = () =>
  page([
    ...HEADER,
    w("定期清掃", 0.1, 0.34), w("式", 0.58, 0.34), w("④⑧,.000", 0.72, 0.34, 0.48), w("48,000", 0.86, 0.34, 0.97),
    w("小計", 0.6, 0.45), w("66,000", 0.84, 0.45, 0.6),
  ]);

const jobOf = (jobs: ReadJob[], column: string | null) => jobs.findIndex((j) => j.column === column);
const outsFor = (jobs: ReadJob[], byColumn: Record<string, ReadOut>) => jobs.map((j) => byColumn[j.column ?? "-"] ?? null);
const field = (r: Awaited<ReturnType<typeof analyzePages>>, key: string, line: number | null = null) => r.output.fields.find((f) => f.key === key && f.line === line);

describe("読み直す場所", () => {
  it("空の数量のマス・形の崩れた単価・自信の低い小計を読み直し、自信のある正しい形の値は読み直さない", () => {
    const jobs = planReads(base());
    expect(jobs.map((j) => `${j.kind}:${j.column ?? "-"}`).sort()).toEqual(["number:-", "number:quantity", "number:unit_price"]);
    const qty = jobs[jobOf(jobs, "quantity")];
    expect(qty.words).toEqual([]);
    // 空のマスは、列の範囲から（となりの列の単語にかからない）
    expect(qty.box.x).toBeGreaterThan(0.156);
    expect(qty.box.x + qty.box.w).toBeLessThan(0.58);
  });

  it("「3台」のように数字に単位が付いた数量や、「一式」のような文字の記載は数字に絞って読み直さない", () => {
    const jobs = planReads(page([...HEADER, w("作業", 0.1, 0.34), w("3台", 0.5, 0.34, 0.7), w("一式", 0.5, 0.37, 0.9), w("作業2", 0.1, 0.37), w("5,000", 0.86, 0.34, 0.97), w("1,000", 0.86, 0.37, 0.97)]));
    expect(jobs.filter((j) => j.column === "quantity" && j.words.length > 0)).toEqual([]);
  });

  it("PDF の文字情報は読み直さない", () => {
    expect(planReads({ ...base(), source: "pdf_text" })).toEqual([]);
  });
});

describe("読み直しの結果の使い方", () => {
  it("空のマスは読み直した値、崩れた値は読み直した値（要確認）、同じ値なら信頼度を上げる", async () => {
    const p = base();
    const jobs = planReads(p);
    const { page: refined, changes } = applyReads(p, jobs, outsFor(jobs, {
      quantity: { text: "1", conf: 0.96, box: null },
      unit_price: { text: "48,000", conf: 0, box: null },
      "-": { text: "66,000", conf: 0, box: null },
    }));
    // 空のマスは位置が分からないので使わない（box: null）。単価は元の単語の位置を使う
    expect(changes.map((c) => `${c.before}→${c.after}`)).toEqual(["48,.000→48,000"]);
    const r = await analyzePages([refined], { allowLlm: false });
    expect(field(r, "unit_price", 0)?.value).toBe("48000");
    expect(field(r, "unit_price", 0)?.source?.conf).toBe(DISAGREE_CONF);
    expect(field(r, "subtotal")?.value).toBe("66000");
    expect(field(r, "subtotal")?.source?.conf).toBe(AGREE_CONF);
    expect(field(r, "quantity", 0)?.value ?? null).toBeNull();
  });

  it("空のマスで読めた数字は、読み取った位置と一緒に使う", async () => {
    const p = base();
    const jobs = planReads(p);
    const box = { x: 0.53, y: 0.34, w: 0.008, h: 0.02 };
    const { page: refined } = applyReads(p, jobs, outsFor(jobs, { quantity: { text: "1", conf: 0.96, box } }));
    const r = await analyzePages([refined], { allowLlm: false });
    expect(field(r, "quantity", 0)?.value).toBe("1");
    const got = field(r, "quantity", 0)?.source?.box;
    for (const k of ["x", "y", "w", "h"] as const) expect(got?.[k]).toBeCloseTo(box[k], 6);
  });

  it("どちらも形の正しい違う値なら、読み直しを使って要確認にする。表の外の数字で桁の数が変わる読み直しは使わない", () => {
    const p = page([...HEADER, w("小計", 0.6, 0.45), w("16,500", 0.84, 0.45, 0.66), w("合計", 0.6, 0.5), w("000", 0.88, 0.5, 0.5)]);
    const jobs = planReads(p);
    const outs = jobs.map((j) => {
      const t = j.words.map((i) => p.words[i].text).join("");
      return { text: t === "16,500" ? "16,600" : "1000", conf: 0.2, box: null };
    });
    const { page: refined } = applyReads(p, jobs, outs);
    expect(refined.words.find((x) => x.text === "16,600")?.conf).toBe(DISAGREE_CONF);
    expect(refined.words.some((x) => x.text === "16,500")).toBe(false);
    expect(refined.words.find((x) => x.text === "000")?.conf).toBe(0.5);
  });

  it("単位：よく使う単位はやや低い信頼度でも使う（要確認のまま）。読めない文字の並びは使わない", () => {
    const p = page([...HEADER, w("画像素材", 0.1, 0.34), w("3", 0.52, 0.34, 0.97), w("4,000", 0.72, 0.34, 0.97), w("12,000", 0.86, 0.34, 0.97)]);
    const jobs = planReads(p);
    const box = { x: 0.59, y: 0.34, w: 0.014, h: 0.02 };
    const ok = applyReads(p, jobs, outsFor(jobs, { unit: { text: "点", conf: 0.51, box } }));
    expect(ok.page.words.find((x) => x.text === "点")?.conf).toBe(0.51);
    const ng = applyReads(p, jobs, outsFor(jobs, { unit: { text: "開詞", conf: 0.3, box } }));
    expect(ng.changes).toEqual([]);
  });
});
