import "server-only";
/**
 * Tesseract（tesseract.js・日本語の学習データ jpn 4.0.0）による OCR。外部に送信しない・追加の費用なし。
 * 単語ごとの座標と信頼度（0〜100）を返す。
 *   1回目：PSM 11（まばらな文字）でページ全体を読む（帳票のラベルと値が離れた配置に強い）
 *   2回目：明細の表の部分だけを PSM 6（行のまとまり）で読み直し、1回目で取りこぼした単語を足す
 *          （数量の「1」・単位の「式」のような、列の中にぽつんとある1文字は PSM 11 では落ちやすい）
 * 学習データは整数化した軽い版（best_int）より数字の読み違いが少ない 4.0.0 を使う（docs/ACCURACY.md）。
 * 同じサーバーの中では読み込んだ worker を使い回し、読み取りは1件ずつ順に行う（読み方の設定を切り替えるため）。
 */
import path from "node:path";
import sharp from "sharp";
import type { Worker } from "tesseract.js";
import { clampBox } from "../geometry";
import { layoutPage } from "../layout";
import type { PageText, Word } from "../types";
import { OcrError, type OcrProvider } from "./types";

declare global {
  var __dfTesseract: Promise<Worker> | undefined;
  var __dfTesseractQueue: Promise<unknown> | undefined;
}

const LANG_DIR = path.join(process.cwd(), "node_modules/@tesseract.js-data/jpn/4.0.0");
const PSM_PAGE = "11";
const PSM_TABLE = "6";
/** 2回目で足す単語の信頼度の下限（これより低い単語は雑音とみなす） */
const MIN_EXTRA_CONF = 60;

async function getWorker(): Promise<Worker> {
  globalThis.__dfTesseract ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("jpn", 1, {
      langPath: LANG_DIR,
      gzip: true,
      cachePath: path.join(process.env.TMPDIR || "/tmp", "docflow-tessdata-4.0.0"),
      logger: () => {},
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM_PAGE as never, user_defined_dpi: "300" });
    return worker;
  })().catch((e) => {
    globalThis.__dfTesseract = undefined;
    throw e;
  });
  return globalThis.__dfTesseract;
}

/** 読み取りを1件ずつ順に行う（同じ worker の読み方の設定を途中で切り替えるため） */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const prev = globalThis.__dfTesseractQueue ?? Promise.resolve();
  const next = prev.then(task, task);
  globalThis.__dfTesseractQueue = next.catch(() => undefined);
  return next;
}

type TBox = { x0: number; y0: number; x1: number; y1: number };
type TWord = { text: string; confidence: number; bbox: TBox };
type TResult = { data: { blocks: { paragraphs: { lines: { words: TWord[] }[] }[] }[] | null } };

function wordsOf(result: TResult, toBox: (b: TBox) => Word["box"], minConf = 0): Word[] {
  const words: Word[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const w of line.words) {
          const text = w.text.trim();
          if (!text) continue;
          const b = w.bbox;
          if (b.x1 <= b.x0 || b.y1 <= b.y0) continue;
          if (w.confidence < minConf) continue;
          words.push({ text, box: clampBox(toBox(b)), conf: Math.max(0, Math.min(1, w.confidence / 100)) });
        }
      }
    }
  }
  return words;
}

const overlaps = (a: Word["box"], b: Word["box"]) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;

/** 明細の表の範囲（見出しの行の下〜小計・合計の行の上）。見出しが無ければ null */
export function tableBand(page: PageText): { top: number; bottom: number } | null {
  const lp = layoutPage(page);
  const head = lp.lines.filter((l) => /数量|単価|単位/.test(l.text));
  if (head.length === 0) return null;
  const top = Math.max(...head.map((l) => l.box.y + l.box.h));
  const ends = lp.lines.filter((l) => l.box.y > top && /小計|合計|税抜|消費税/.test(l.text)).map((l) => l.box.y);
  const bottom = ends.length ? Math.min(...ends) : 1;
  return bottom - top > 0.01 ? { top, bottom } : null;
}

export class TesseractOcr implements OcrProvider {
  readonly name = "tesseract";
  readonly engine = "tesseract.js 7 / jpn 4.0.0";

  async recognize(image: Buffer, size: { width: number; height: number }, page: number): Promise<PageText> {
    let worker: Worker;
    try {
      worker = await getWorker();
    } catch (e) {
      throw new OcrError(`OCR エンジンを起動できません：${e instanceof Error ? e.message : String(e)}`, true);
    }
    return serialize(async () => {
      const result = (await worker.recognize(image, {}, { blocks: true, text: false })) as unknown as TResult;
      const words = wordsOf(result, (b) => ({ x: b.x0 / size.width, y: b.y0 / size.height, w: (b.x1 - b.x0) / size.width, h: (b.y1 - b.y0) / size.height }));
      const base: PageText = { page, width: size.width, height: size.height, source: words.length > 0 ? "ocr" : "none", engine: this.engine, words };
      const band = words.length > 0 ? tableBand(base) : null;
      if (!band) return base;
      // 2回目：表の部分を切り出して読み直す（座標は切り出す前の画像に戻す）
      const y0 = Math.floor(band.top * size.height);
      const y1 = Math.min(size.height, Math.ceil(band.bottom * size.height));
      const crop = await sharp(image).extract({ left: 0, top: y0, width: size.width, height: y1 - y0 }).png().toBuffer();
      await worker.setParameters({ tessedit_pageseg_mode: PSM_TABLE as never });
      let second: TResult;
      try {
        second = (await worker.recognize(crop, {}, { blocks: true, text: false })) as unknown as TResult;
      } finally {
        await worker.setParameters({ tessedit_pageseg_mode: PSM_PAGE as never });
      }
      const extra = wordsOf(second, (b) => ({ x: b.x0 / size.width, y: (b.y0 + y0) / size.height, w: (b.x1 - b.x0) / size.width, h: (b.y1 - b.y0) / size.height }), MIN_EXTRA_CONF)
        .filter((w) => !words.some((o) => overlaps(o.box, w.box)));
      return { ...base, words: [...words, ...extra] };
    });
  }
}
