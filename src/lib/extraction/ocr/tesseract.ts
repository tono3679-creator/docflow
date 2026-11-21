import "server-only";
/**
 * Tesseract（tesseract.js・日本語の学習データ jpn best_int）による OCR。外部に送信しない・追加の費用なし。
 * 単語ごとの座標と信頼度（0〜100）を返す。PSM 11（まばらな文字）で帳票の配置に強くする。
 * 同じサーバーの中では読み込んだ worker を使い回す。
 */
import path from "node:path";
import type { Worker } from "tesseract.js";
import { clampBox } from "../geometry";
import type { PageText, Word } from "../types";
import { OcrError, type OcrProvider } from "./types";

declare global {
  var __dfTesseract: Promise<Worker> | undefined;
}

const LANG_DIR = path.join(process.cwd(), "node_modules/@tesseract.js-data/jpn/4.0.0_best_int");

async function getWorker(): Promise<Worker> {
  globalThis.__dfTesseract ??= (async () => {
    const { createWorker, PSM } = await import("tesseract.js");
    const worker = await createWorker("jpn", 1, {
      langPath: LANG_DIR,
      gzip: true,
      cachePath: path.join(process.env.TMPDIR || "/tmp", "docflow-tessdata"),
      logger: () => {},
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, user_defined_dpi: "300" });
    return worker;
  })().catch((e) => {
    globalThis.__dfTesseract = undefined;
    throw e;
  });
  return globalThis.__dfTesseract;
}

type TBox = { x0: number; y0: number; x1: number; y1: number };
type TWord = { text: string; confidence: number; bbox: TBox };

export class TesseractOcr implements OcrProvider {
  readonly name = "tesseract";
  readonly engine = "tesseract.js 7 / jpn best_int";

  async recognize(image: Buffer, size: { width: number; height: number }, page: number): Promise<PageText> {
    let worker: Worker;
    try {
      worker = await getWorker();
    } catch (e) {
      throw new OcrError(`OCR エンジンを起動できません：${e instanceof Error ? e.message : String(e)}`, true);
    }
    const result = await worker.recognize(image, {}, { blocks: true, text: false });
    const words: Word[] = [];
    for (const block of result.data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          for (const w of line.words as TWord[]) {
            const text = w.text.trim();
            if (!text) continue;
            const b = w.bbox;
            if (b.x1 <= b.x0 || b.y1 <= b.y0) continue;
            words.push({
              text,
              box: clampBox({ x: b.x0 / size.width, y: b.y0 / size.height, w: (b.x1 - b.x0) / size.width, h: (b.y1 - b.y0) / size.height }),
              conf: Math.max(0, Math.min(1, w.confidence / 100)),
            });
          }
        }
      }
    }
    return { page, width: size.width, height: size.height, source: words.length > 0 ? "ocr" : "none", engine: this.engine, words };
  }
}
