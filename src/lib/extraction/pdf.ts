import "server-only";
/**
 * PDF の読み込み（サーバー）。pdf.js を使い、XFA フォームは無効（pdf.js v6 は PDF 内のスクリプトを実行しない）。
 *   inspectPdf      … ページ数・パスワード・埋め込みスクリプト・添付ファイルの確認
 *   extractPdfText  … 文字情報のある PDF から単語と座標を取り出す（OCR より優先する）
 *   renderPdfPage   … OCR のためにページを画像にする
 */
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/pdf";
import { clampBox } from "./geometry";
import { charWeight } from "./text";
import type { PageText, Word } from "./types";

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function pdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

const PDFJS_DIR = path.join(process.cwd(), "node_modules/pdfjs-dist");

export class PdfInspectError extends Error {
  constructor(message: string, public code: "encrypted" | "corrupt" | "script" | "attachment") {
    super(message);
    this.name = "PdfInspectError";
  }
}

export type OpenedPdf = { pdf: PDFDocumentProxy; close: () => Promise<void> };

export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const lib = await pdfjs();
  const task = lib.getDocument({
      data: new Uint8Array(bytes),
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      standardFontDataUrl: `${PDFJS_DIR}/standard_fonts/`,
      cMapUrl: `${PDFJS_DIR}/cmaps/`,
      cMapPacked: true,
      verbosity: 0,
    });
  try {
    const pdf = await task.promise;
    return { pdf, close: () => task.destroy() };
  } catch (e) {
    await task.destroy().catch(() => {});
    const name = (e as { name?: string })?.name;
    if (name === "PasswordException") throw new PdfInspectError("パスワード付きの PDF は読み取れません", "encrypted");
    throw new PdfInspectError("PDF を開けません（ファイルが壊れている可能性があります）", "corrupt");
  }
}

export type PdfInspection = { pageCount: number; hasScript: boolean; hasAttachments: boolean };

/** pdf.js v6 は Map を返す（以前の版は普通のオブジェクト）。どちらでも件数を数える */
function entryCount(x: unknown): number {
  if (!x) return 0;
  if (x instanceof Map) return x.size;
  if (typeof x === "object") return Object.keys(x).length;
  return 0;
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const { pdf, close } = await openPdf(bytes);
  try {
    const [js, attachments] = await Promise.all([
      pdf.getJSActions().catch(() => null),
      pdf.getAttachments().catch(() => null),
    ]);
    let hasScript = entryCount(js) > 0;
    // ページごとの操作（開いたときのスクリプトなど）も確かめる
    for (let p = 1; p <= Math.min(pdf.numPages, 50) && !hasScript; p++) {
      const page = await pdf.getPage(p);
      const pageJs = await page.getJSActions().catch(() => null);
      if (entryCount(pageJs) > 0) hasScript = true;
      page.cleanup();
    }
    return { pageCount: pdf.numPages, hasScript, hasAttachments: entryCount(attachments) > 0 };
  } finally {
    await close();
  }
}

type TextItemLike = { str: string; transform: number[]; width: number; height: number; fontName: string };

/** ページの文字情報を単語に分ける。横書き以外（回転した文字）は使わない */
export async function extractPdfText(page: PDFPageProxy, pageNumber: number): Promise<PageText> {
  const lib = await pdfjs();
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const words: Word[] = [];
  for (const raw of content.items) {
    if (!("str" in raw)) continue;
    const item = raw as TextItemLike;
    if (!item.str || !item.str.trim()) continue;
    const tx = lib.Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(tx[1], tx[0]);
    if (Math.abs(angle) > 0.05) continue;
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const style = content.styles[item.fontName] as { ascent?: number; descent?: number } | undefined;
    const ascent = style?.ascent && style.ascent > 0 ? style.ascent : 0.88;
    const top = tx[5] - fontHeight * ascent;
    const width = item.width * viewport.scale;
    if (width <= 0 || fontHeight <= 0) continue;
    // 空白で区切り、各単語の位置を文字の幅の目安で按分する
    const chars = [...item.str];
    const weights = chars.map(charWeight);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let pos = 0;
    let current = "";
    let start = 0;
    const push = (endPos: number) => {
      if (!current.trim()) return;
      const x = tx[4] + (width * start) / total;
      const w = (width * (endPos - start)) / total;
      words.push({
        text: current,
        box: clampBox({ x: x / viewport.width, y: top / viewport.height, w: w / viewport.width, h: fontHeight / viewport.height }),
        conf: null,
      });
    };
    chars.forEach((ch, i) => {
      if (/\s/.test(ch)) {
        push(pos);
        current = "";
        pos += weights[i];
        start = pos;
      } else {
        current += ch;
        pos += weights[i];
      }
    });
    push(pos);
  }
  return { page: pageNumber, width: viewport.width, height: viewport.height, source: words.length > 0 ? "pdf_text" : "none", engine: "pdfjs", words };
}

/** OCR 用にページを PNG にする（長い辺が maxSide ピクセル程度） */
export async function renderPdfPage(page: PDFPageProxy, maxSide = 2400): Promise<{ png: Buffer; width: number; height: number }> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, maxSide / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport,
  }).promise;
  return { png: canvas.toBuffer("image/png"), width: canvas.width, height: canvas.height };
}
