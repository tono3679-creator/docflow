import "server-only";
/**
 * 読取の流れ（AI 処理と画面の処理は分けている。画面からはこの関数の結果を DB 経由で使う）。
 *   1. PDF：ページごとに文字情報を取り出す。文字が無いページ（スキャン）だけ画像にして OCR
 *      画像：向きを直した PNG にして OCR
 *   2. 単語を行にまとめる（座標付き）
 *   3. 書類種別の判定（LLM を許可していれば LLM、無ければルール。利用者が指定した種別があればそれ）
 *   4. 項目抽出（LLM またはルール）→ 原本の文字と対応付け
 * 検証（金額照合・要確認の判定）は src/lib/validation で別に行う。
 */
import { aiEnv } from "@/lib/env";
import { classifyDocument } from "./classify";
import { extractPdfText, openPdf, renderPdfPage } from "./pdf";
import { normalizeImage, upscaleForOcr } from "./image";
import { layoutPage, type LayoutPage } from "./layout";
import { AnthropicExtractor, LlmError, type LlmExtractor } from "./llm/anthropic";
import { mapLlmOutput } from "./llm/map";
import { buildDocumentText } from "./llm/prompt";
import { ocrProvider } from "./ocr";
import { extractWithRules } from "./rules-extractor";
import { isKnownType, type KnownType } from "./schema";
import type { ClassificationResult, DocumentType, ExtractionOutput, PageText } from "./types";

/** スキャンとみなす：文字情報がこれより少ないページ */
const MIN_TEXT_CHARS = 15;

export type UsageEntry = {
  kind: "pdf_text" | "ocr" | "llm";
  provider: string;
  model: string | null;
  pages: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  success: boolean;
  error: string | null;
};

export type ReadResult = {
  pages: PageText[];
  /** 画像の書類：表示用の PNG（座標の基準） */
  preview: { png: Buffer; width: number; height: number } | null;
  usage: UsageEntry[];
  ocrUsed: boolean;
};

export type AnalyzeResult = {
  output: ExtractionOutput;
  method: string;
  llm: { provider: string; model: string } | null;
  usage: UsageEntry[];
};

let llmOverride: LlmExtractor | null | undefined;
export function setLlmForTests(e: LlmExtractor | null | undefined) {
  llmOverride = e;
}

function llmExtractor(): LlmExtractor | null {
  if (llmOverride !== undefined) return llmOverride;
  const env = aiEnv();
  if (env.llmProvider === "anthropic") return new AnthropicExtractor(env.anthropicApiKey, env.llmModel);
  return null;
}

/** 1. 原本から文字と座標を取り出す */
export async function readDocument(bytes: Uint8Array, fileType: "pdf" | "png" | "jpeg" | "webp"): Promise<ReadResult> {
  const usage: UsageEntry[] = [];
  const pages: PageText[] = [];
  let ocrUsed = false;
  if (fileType === "pdf") {
    const started = Date.now();
    const { pdf, close } = await openPdf(bytes);
    let ocrPages = 0;
    let ocrMs = 0;
    try {
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const text = await extractPdfText(page, p);
        const chars = text.words.reduce((n, w) => n + w.text.length, 0);
        if (chars >= MIN_TEXT_CHARS) {
          pages.push(text);
        } else {
          const t0 = Date.now();
          const img = await renderPdfPage(page);
          const ocr = await ocrProvider().recognize(img.png, { width: img.width, height: img.height }, p);
          // 基準の大きさは PDF のページ（座標は比率なので同じ）
          pages.push({ ...ocr, width: text.width, height: text.height });
          ocrPages++;
          ocrMs += Date.now() - t0;
        }
        page.cleanup();
      }
    } finally {
      await close();
    }
    usage.push({ kind: "pdf_text", provider: "pdfjs", model: null, pages: pages.length - ocrPages, inputTokens: null, outputTokens: null, durationMs: Date.now() - started - ocrMs, success: true, error: null });
    if (ocrPages > 0) {
      ocrUsed = true;
      usage.push({ kind: "ocr", provider: ocrProvider().name, model: ocrProvider().engine, pages: ocrPages, inputTokens: null, outputTokens: null, durationMs: ocrMs, success: true, error: null });
    }
    return { pages, preview: null, usage, ocrUsed };
  }
  const img = await normalizeImage(bytes);
  const t0 = Date.now();
  const forOcr = await upscaleForOcr(img);
  const ocr = await ocrProvider().recognize(forOcr.png, { width: forOcr.width, height: forOcr.height }, 1);
  usage.push({ kind: "ocr", provider: ocrProvider().name, model: ocrProvider().engine, pages: 1, inputTokens: null, outputTokens: null, durationMs: Date.now() - t0, success: true, error: null });
  // 基準の大きさは表示用の画像（座標は比率なので、拡大した画像で読んでも同じ）
  return { pages: [{ ...ocr, width: img.width, height: img.height }], preview: img, usage, ocrUsed: true };
}

/** 2〜4. 文字と座標から、種別と項目を取り出す（保存済みのページから読み直すときもここから） */
/**
 * allowLlm：組織の設定で外部の AI に送ることを許可しているときだけ true（既定は送らない）。
 * 許可されていても API キーが無ければルール抽出になる。
 */
export async function analyzePages(pages: PageText[], options: { forcedType?: DocumentType | null; signal?: AbortSignal; lastAttempt?: boolean; allowLlm?: boolean } = {}): Promise<AnalyzeResult> {
  const layout: LayoutPage[] = pages.map((p) => layoutPage(p));
  const usage: UsageEntry[] = [];
  const notes: string[] = [];
  const ruleClass = classifyDocument(layout);
  const forced = options.forcedType && options.forcedType !== "unknown" ? options.forcedType : null;
  const textFound = layout.some((lp) => lp.lines.length > 0);

  const llm = textFound && options.allowLlm ? llmExtractor() : null;
  if (llm) {
    const t0 = Date.now();
    try {
      const { output, usage: u } = await llm.extract(buildDocumentText(layout, aiEnv().llmMaskSensitive), { forcedType: forced, signal: options.signal });
      usage.push({ kind: "llm", provider: llm.provider, model: llm.model, pages: pages.length, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: Date.now() - t0, success: true, error: null });
      const type: DocumentType = forced ?? output.document_type;
      const classification: ClassificationResult = forced
        ? { type: forced, scores: ruleClass.scores, evidence: ["利用者が指定"], method: "rules" }
        : { type: output.document_type, scores: ruleClass.scores, evidence: output.type_evidence.slice(0, 8), method: "llm" };
      const rules = isKnownType(type) ? extractWithRules(layout, type) : null;
      const mapped = isKnownType(type) ? mapLlmOutput(layout, output, type) : { fields: [], lineItems: [], dropped: [] };
      if (mapped.dropped.length > 0) notes.push(`AI が示した値のうち、原本に根拠が見つからない・原本と食い違う ${mapped.dropped.length} 件は使っていません（未取得として表示）`);
      const context = rules?.context ?? { textFound, taxIncluded: null, rounding: null, statedRates: [], hasReducedMarker: false };
      if (output.tax_included !== null) context.taxIncluded = output.tax_included;
      return {
        output: { documentType: type, classification, fields: mapped.fields, lineItems: mapped.lineItems, context: { ...context, textFound }, notes },
        method: `${pages.some((p) => p.source === "ocr") ? "ocr" : "pdf_text"}+llm`,
        llm: { provider: llm.provider, model: llm.model },
        usage,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      usage.push({ kind: "llm", provider: llm.provider, model: llm.model, pages: pages.length, inputTokens: null, outputTokens: null, durationMs: Date.now() - t0, success: false, error: message.slice(0, 500) });
      if (!aiEnv().llmFallbackToRules) throw e;
      if (e instanceof LlmError && e.retryable && !options.lastAttempt && !options.signal?.aborted) {
        // リトライできる失敗は、処理のリトライに任せる（ルールに切り替えない）
        throw e;
      }
      notes.push(`AI の抽出に失敗したため、ルール抽出で処理しました（${message.slice(0, 80)}）`);
    }
  }

  const type: DocumentType = forced ?? ruleClass.type;
  const classification: ClassificationResult = forced ? { ...ruleClass, type: forced, evidence: ["利用者が指定", ...ruleClass.evidence] } : ruleClass;
  if (!isKnownType(type)) {
    return {
      output: { documentType: type, classification, fields: [], lineItems: [], context: { textFound, taxIncluded: null, rounding: null, statedRates: [], hasReducedMarker: false }, notes },
      method: `${pages.some((p) => p.source === "ocr") ? "ocr" : "pdf_text"}+rules`,
      llm: null,
      usage,
    };
  }
  const r = extractWithRules(layout, type as KnownType);
  return {
    output: { documentType: type, classification, fields: r.fields, lineItems: r.lineItems, context: { ...r.context, textFound }, notes },
    method: `${pages.some((p) => p.source === "ocr") ? "ocr" : "pdf_text"}+rules`,
    llm: null,
    usage,
  };
}
