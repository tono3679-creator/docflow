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
