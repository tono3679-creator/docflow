/**
 * 読取（ルール抽出）の回帰テストと、AI（LLM）を模擬した抽出のテスト。
 *   - demo/results に保存した実際の読取結果（文字と座標）から抽出し直し、PDF の見出し項目がすべて正解であること
 *   - 書類に印字されていない値を入れないこと（推測で埋めない）
 *   - AI の応答が壊れている・失敗した・書類に無い値を返したときの扱い
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LlmError, type LlmExtractor } from "@/lib/extraction/llm/anthropic";
import { buildDocumentText, maskSensitive, type LlmOutputT } from "@/lib/extraction/llm/prompt";
import { layoutPage } from "@/lib/extraction/layout";
import { analyzePages, setLlmForTests } from "@/lib/extraction/pipeline";
import { compactKey } from "@/lib/extraction/text";
import type { PageText } from "@/lib/extraction/types";

const ROOT = path.resolve(import.meta.dirname, "../..");
type Truth = { id: string; render: string; document_type: string; fields: Record<string, string | null> };

async function load(id: string): Promise<{ pages: PageText[] }> {
  return JSON.parse(await readFile(path.join(ROOT, "demo/results", `${id}.json`), "utf8"));
}

afterEach(() => setLlmForTests(undefined));

describe("ルール抽出（デモ書類の実際の読取結果から）", async () => {
  const truth: Truth[] = JSON.parse(await readFile(path.join(ROOT, "demo/ground-truth.json"), "utf8"));
  const pdfs = truth.filter((t) => t.render === "pdf");

  it(`PDF ${pdfs.length} 件：種別と、印字されている見出しの項目がすべて正解・原本の位置つき`, async () => {
    const wrong: string[] = [];
    for (const t of pdfs) {
      const { pages } = await load(t.id);
      const r = await analyzePages(pages, { allowLlm: false });
      if (r.output.documentType !== t.document_type) wrong.push(`${t.id} 種別 ${r.output.documentType}`);
      for (const [key, expected] of Object.entries(t.fields)) {
        if (expected === null) continue;
        const got = r.output.fields.find((f) => f.line === null && f.key === key);
        if (!got?.value || compactKey(got.value) !== compactKey(expected)) wrong.push(`${t.id} ${key}: ${got?.value} ≠ ${expected}`);
        else if (!got.source) wrong.push(`${t.id} ${key}: 位置なし`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("すべての書類で、印字されていない項目に値を入れない", async () => {
    const invented: string[] = [];
    for (const t of truth) {
      const { pages } = await load(t.id);
      const r = await analyzePages(pages, { allowLlm: false });
      if (r.output.documentType !== t.document_type) continue;
      for (const [key, expected] of Object.entries(t.fields)) {
        const got = r.output.fields.find((f) => f.line === null && f.key === key);
        if (expected === null && got?.value) invented.push(`${t.id} ${key}=${got.value}`);
      }
    }
    expect(invented).toEqual([]);
  });

  it("画像・スキャンの書類（読み取れない画像を除く）：見出しの項目の 93% 以上が正解", async () => {
    let total = 0;
    let correct = 0;
    for (const t of truth.filter((x) => x.render !== "pdf" && x.render !== "jpeg_unreadable")) {
      const { pages } = await load(t.id);
      const r = await analyzePages(pages, { allowLlm: false });
      for (const [key, expected] of Object.entries(t.fields)) {
        if (expected === null) continue;
        total++;
        const got = r.output.fields.find((f) => f.line === null && f.key === key);
        if (got?.value && compactKey(got.value) === compactKey(expected)) correct++;
      }
    }
    expect(correct / total).toBeGreaterThanOrEqual(0.93);
  });

  it("文字の無いページは種別不明・項目なし（推測しない）", async () => {
    const r = await analyzePages([{ page: 1, width: 600, height: 800, source: "ocr", engine: "test", words: [] }]);
    expect(r.output.documentType).toBe("unknown");
    expect(r.output.fields).toEqual([]);
    expect(r.output.context.textFound).toBe(false);
  });
});

// ---------------------------------------------------------------
// AI（LLM）を模擬
// ---------------------------------------------------------------
const word = (text: string, x: number, y: number) => ({ text, box: { x, y, w: 0.012 * text.length, h: 0.02 }, conf: null });
const PAGE: PageText = {
  page: 1, width: 595, height: 842, source: "pdf_text", engine: "test",
  words: [
    word("請求書", 0.45, 0.05),
    word("株式会社テスト商事", 0.6, 0.15),
    word("請求番号", 0.6, 0.1), word("T-001", 0.72, 0.1),
    word("発行日", 0.6, 0.12), word("2026年11月1日", 0.72, 0.12),
    word("小計", 0.6, 0.6), word("10,000", 0.8, 0.6),
    word("消費税(10%)", 0.6, 0.63), word("1,000", 0.8, 0.63),
    word("合計", 0.6, 0.66), word("11,000", 0.8, 0.66),
    word("振込先", 0.1, 0.8), word("普通", 0.2, 0.8), word("1234567", 0.3, 0.8),
  ],
};

const v = (value: string | null, source_text: string | null = value) => ({ value, source_text, line_ids: [] as string[] });
const emptyLine = { description: v(null), quantity: v(null), unit: v(null), unit_price: v(null), amount: v(null), tax_rate: v(null) };

function fake(output: LlmOutputT | Error): LlmExtractor & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider: "fake",
    model: "fake-model",
    calls,
    async extract(text) {
      calls.push(text);
      if (output instanceof Error) throw output;
      return { output, usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
}

const goodOutput = (over: Partial<LlmOutputT> = {}): LlmOutputT => ({
  document_type: "invoice",
  type_evidence: ["請求書"],
  fields: [
    { key: "issuer_name", ...v("株式会社テスト商事") },
    { key: "invoice_number", ...v("T-001") },
    { key: "issue_date", ...v("2026-11-01", "2026年11月1日") },
    { key: "subtotal", ...v("10000", "10,000") },
    { key: "tax_amount", ...v("1000", "1,000") },
    { key: "total_amount", ...v("11000", "11,000") },
  ],
  line_items: [],
  tax_included: false,
  ...over,
});

describe("AI による抽出（応答を模擬）", () => {
  it("組織が許可していなければ AI を呼ばない（既定は送らない）", async () => {
    const llm = fake(goodOutput());
    setLlmForTests(llm);
    const r = await analyzePages([PAGE]);
    expect(llm.calls).toHaveLength(0);
    expect(r.method).toBe("pdf_text+rules");
  });

  it("正しい応答：値を原本の位置に対応付け、利用量を記録する", async () => {
    setLlmForTests(fake(goodOutput()));
    const r = await analyzePages([PAGE], { allowLlm: true });
    expect(r.method).toBe("pdf_text+llm");
    const total = r.output.fields.find((f) => f.key === "total_amount")!;
    expect(total.value).toBe("11000");
    expect(total.source?.page).toBe(1);
    expect(r.usage.find((u) => u.kind === "llm")).toMatchObject({ success: true, inputTokens: 100, outputTokens: 50 });
  });

  it("書類に無い値・原本と食い違う値は使わない（推測・書き換えで埋めない）", async () => {
    setLlmForTests(fake(goodOutput({
      fields: [
        { key: "issuer_name", ...v("株式会社テスト商事") },
        { key: "recipient_name", ...v("株式会社どこか", "株式会社どこか") },
        { key: "total_amount", ...v("12000", "11,000") },
        { key: "due_date", ...v("2026-11-30", null) },
      ],
    })));
    const r = await analyzePages([PAGE], { allowLlm: true });
    const get = (k: string) => r.output.fields.find((f) => f.key === k);
    expect(get("issuer_name")?.value).toBe("株式会社テスト商事");
    expect(get("recipient_name")?.value).toBeNull();
    expect(get("total_amount")?.value).toBeNull();
    expect(get("due_date")?.value).toBeNull();
    expect(r.output.notes.join()).toContain("使っていません");
  });

  it("失敗（リトライできない）したら、ルール抽出に切り替えて記録する", async () => {
    setLlmForTests(fake(new LlmError("AI の API キーが正しくありません", false)));
    const r = await analyzePages([PAGE], { allowLlm: true });
    expect(r.method).toBe("pdf_text+rules");
    expect(r.output.notes.join()).toContain("ルール抽出");
    expect(r.usage.find((u) => u.kind === "llm")).toMatchObject({ success: false });
  });

  it("リトライできる失敗（形式の誤りなど）は処理のリトライに任せ、最後の試行ならルール抽出", async () => {
    setLlmForTests(fake(new LlmError("AI の応答の形式が正しくありません", true)));
    await expect(analyzePages([PAGE], { allowLlm: true })).rejects.toThrow("形式");
    const last = await analyzePages([PAGE], { allowLlm: true, lastAttempt: true });
    expect(last.method).toBe("pdf_text+rules");
  });

  it("AI に送るのは文字だけ。口座番号・電話番号は伏せ、書類の文章は行IDつきのデータとして渡す", async () => {
    const llm = fake(goodOutput({ line_items: [emptyLine] }));
    setLlmForTests(llm);
    await analyzePages([PAGE], { allowLlm: true });
    expect(llm.calls[0]).not.toContain("1234567");
    expect(llm.calls[0]).toMatch(/\[p1-l\d+\]/);
    expect(maskSensitive("TEL 03-1234-5678 口座 1234567")).not.toMatch(/5678|1234567/);
    expect(buildDocumentText([layoutPage(PAGE)], false)).toContain("1234567");
  });

  it("利用者が書類種別を指定したときは、その種別で抽出する", async () => {
    setLlmForTests(fake(goodOutput({ document_type: "receipt" })));
    const r = await analyzePages([PAGE], { allowLlm: true, forcedType: "invoice" });
    expect(r.output.documentType).toBe("invoice");
  });
});

// ---------------------------------------------------------------
// OCR のよくある読み違い（実際のデモのスキャン画像で起きたもの）
// ---------------------------------------------------------------
describe("OCR の読み違いへの対応", () => {
  const ocrWord = (text: string, x: number, y: number) => ({ text, box: { x, y, w: 0.014 * text.length, h: 0.02 }, conf: 0.9 });
  const ocrPage = (words: ReturnType<typeof ocrWord>[]): PageText => ({ page: 1, width: 1000, height: 1400, source: "ocr", engine: "test", words });
  const field = (r: Awaited<ReturnType<typeof analyzePages>>, key: string, line: number | null = null) => r.output.fields.find((f) => f.key === key && f.line === line)?.value ?? null;

  it("大きな「¥」を日本語の文字に読み違えた金額・「No. (」・「但し書籍代」", async () => {
    const r = await analyzePages([ocrPage([
      ocrWord("領収書", 0.45, 0.05),
      ocrWord("No.", 0.7, 0.1), ocrWord("(CM-3391", 0.75, 0.1),
      ocrWord("株式会社山田商事", 0.1, 0.15), ocrWord("様", 0.32, 0.15),
      ocrWord("領収金額", 0.1, 0.25), ocrWord("ぞそ6,", 0.4, 0.25), ocrWord("380-", 0.49, 0.25),
      ocrWord("但し", 0.1, 0.3), ocrWord("書籍代として", 0.15, 0.3),
      ocrWord("税抜金額", 0.1, 0.4), ocrWord("羊5,", 0.4, 0.4), ocrWord("800", 0.45, 0.4),
      ocrWord("消費税", 0.1, 0.45), ocrWord("10め", 0.2, 0.45), ocrWord("¥580", 0.4, 0.45),
    ])], { allowLlm: false });
    expect(r.output.documentType).toBe("receipt");
    expect(field(r, "receipt_number")).toBe("CM-3391");
    expect(field(r, "total_amount")).toBe("6380");
    expect(field(r, "subtotal")).toBe("5800");
    expect(field(r, "tax_amount")).toBe("580");
    expect(field(r, "purpose")).toBe("書籍代として");
  });

  it("消費税の後ろに金額が無ければ、税率と読み違えたかもしれない 10 もそのまま使う（捨てない）", async () => {
    const r = await analyzePages([ocrPage([
      ocrWord("領収書", 0.45, 0.05),
      ocrWord("消費税", 0.1, 0.45), ocrWord("10", 0.2, 0.45),
    ])], { allowLlm: false });
    expect(field(r, "tax_amount")).toBe("10");
  });

  it("明細の見出しの「単」の読み違い（除位・南価）と、単位と単価がくっついた読み取り", async () => {
    const r = await analyzePages([ocrPage([
      ocrWord("納品書", 0.45, 0.05),
      ocrWord("品名", 0.1, 0.3), ocrWord("数量", 0.5, 0.3), ocrWord("除位", 0.58, 0.3), ocrWord("南価", 0.72, 0.3), ocrWord("金額", 0.88, 0.3),
      ocrWord("清掃用洗剤", 0.1, 0.34), ocrWord("4", 0.53, 0.34), ocrWord("本2,800", 0.6, 0.34), ocrWord("11.200", 0.88, 0.34),
      ocrWord("小計", 0.6, 0.45), ocrWord("¥11,200", 0.85, 0.45),
    ])], { allowLlm: false });
    expect(field(r, "quantity", 0)).toBe("4");
    expect(field(r, "unit", 0)).toBe("本");
    expect(field(r, "unit_price", 0)).toBe("2800");
    expect(field(r, "amount", 0)).toBe("11200");
  });

  it("数字の無い1文字や記号だけの読み取り（「)」「:」）は値にせず未取得。「一式」のような記載は残す", async () => {
    const r = await analyzePages([ocrPage([
      ocrWord("請求書", 0.45, 0.05),
      ocrWord("品名", 0.1, 0.3), ocrWord("数量", 0.5, 0.3), ocrWord("単位", 0.58, 0.3), ocrWord("単価", 0.72, 0.3), ocrWord("金額", 0.88, 0.3),
      ocrWord("採用ページ更新", 0.1, 0.34), ocrWord(")", 0.53, 0.34), ocrWord(":", 0.6, 0.34), ocrWord("38,000", 0.72, 0.34), ocrWord("38,000", 0.86, 0.34),
      ocrWord("設置工事", 0.1, 0.37), ocrWord("一式", 0.5, 0.37), ocrWord("10,000", 0.86, 0.37),
      ocrWord("小計", 0.6, 0.45), ocrWord("¥48,000", 0.84, 0.45),
    ])], { allowLlm: false });
    expect(field(r, "quantity", 0)).toBeNull();
    expect(field(r, "unit", 0)).toBeNull();
    expect(field(r, "unit_price", 0)).toBe("38000");
    expect(field(r, "quantity", 1)).toBe("一式");
  });
});

describe("品名の表記（原本の空白を残す）", () => {
  const field = (r: Awaited<ReturnType<typeof analyzePages>>, key: string, line: number | null = null) => r.output.fields.find((f) => f.key === key && f.line === line)?.value ?? null;
  // 幅 1000・高さ 1400 のページで文字の高さ 0.02 → 横の比率で 0.028。単語の幅は文字数 × 0.014（半角は狭いが、ここでは揃える）
  const at = (text: string, x: number, y: number, conf: number | null) => ({ text, box: { x, y, w: 0.014 * text.length, h: 0.02 }, conf });
  const table = (source: "pdf_text" | "ocr", desc: { text: string; gap: number }[]): PageText => {
    const conf = source === "ocr" ? 0.95 : null;
    const words = [at("請求書", 0.45, 0.05, conf), at("品名", 0.1, 0.3, conf), at("数量", 0.5, 0.3, conf), at("単価", 0.72, 0.3, conf), at("金額", 0.88, 0.3, conf)];
    let x = 0.1;
    for (const d of desc) {
      x += d.gap * 0.028;
      words.push(at(d.text, x, 0.34, conf));
      x += 0.014 * d.text.length;
    }
    words.push(at("2", 0.53, 0.34, conf), at("500", 0.72, 0.34, conf), at("1,000", 0.86, 0.34, conf));
    return { page: 1, width: 1000, height: 1400, source, engine: "test", words };
  };

  it("PDF：原本の空白はそのまま（「コピー用紙A4500枚」にしない・日本語どうしの間も残す）", async () => {
    const r = await analyzePages([table("pdf_text", [{ text: "コピー用紙", gap: 0 }, { text: "A4", gap: 0.53 }, { text: "500枚", gap: 0.53 }])], { allowLlm: false });
    expect(field(r, "description", 0)).toBe("コピー用紙 A4 500枚");
    const r2 = await analyzePages([table("pdf_text", [{ text: "ボールペン", gap: 0 }, { text: "黒", gap: 0.54 }, { text: "10本", gap: 0.54 }])], { allowLlm: false });
    expect(field(r2, "description", 0)).toBe("ボールペン 黒 10本");
  });

  it("OCR：日本語→数字の間が空いていれば空白、数字→日本語（「11月」）はつなげる、日本語どうしの間の空白は除く", async () => {
    const r = await analyzePages([table("ocr", [{ text: "定期", gap: 0 }, { text: "清掃", gap: 0.6 }, { text: "11", gap: 0.45 }, { text: "月分", gap: 0.59 }])], { allowLlm: false });
    expect(field(r, "description", 0)).toBe("定期清掃 11月分");
  });
});
