import "server-only";
/**
 * Tesseract（tesseract.js・日本語の学習データ jpn 4.0.0、数字の読み直しに eng）による OCR。外部に送信しない・追加の費用なし。
 * 単語ごとの座標と信頼度（0〜100）を返す。
 *   1回目：PSM 11（まばらな文字）でページ全体を読む（帳票のラベルと値が離れた配置に強い）
 *   2回目：明細の表の部分だけを PSM 6（行のまとまり）で読み直し、1回目で取りこぼした単語を足す
 *          （数量の「1」・単位の「式」のような、列の中にぽつんとある1文字は PSM 11 では落ちやすい）
 *   3回目：明細のマス（数量・単位・単価・金額）と、表の外の自信の低い数字を1つずつ切り出して読み直す（ocr/refine.ts）。
 *          数字は英語の学習データ（eng 4.0.0_best_int）で「数字と , . - / だけ」に絞って読む。
 *          日本語の学習データは数字を「④⑧」のような丸数字と取り違えやすく、絞っても崩れる（実験済み）
 * 日本語の学習データは整数化した軽い版（best_int）より数字の読み違いが少ない 4.0.0 を使う（docs/ACCURACY.md）。
 * 同じサーバーの中では読み込んだ worker を使い回し、読み取りは1件ずつ順に行う（読み方の設定を切り替えるため）。
 */
import path from "node:path";
import sharp from "sharp";
import type { Worker } from "tesseract.js";
import { clampBox, union } from "../geometry";
import { layoutPage } from "../layout";
import type { PageText, Word } from "../types";
import { applyReads, planReads, type ReadJob, type ReadOut } from "./refine";
import { OcrError, type OcrProvider } from "./types";

declare global {
  var __dfTesseract: Promise<Worker> | undefined;
  var __dfTesseractDigits: Promise<Worker> | undefined;
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

/** 数字の読み直しは 4.0.0 と 4.0.0_best_int で結果が同じだったので、軽い best_int（約 3MB）を使う */
const DIGITS_DIR = path.join(process.cwd(), "node_modules/@tesseract.js-data/eng/4.0.0_best_int");
const DIGIT_CHARS = "0123456789,.-/";

/** 数字のマスを読む worker（数字と区切りの文字だけに絞る） */
async function getDigitsWorker(): Promise<Worker> {
  globalThis.__dfTesseractDigits ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng", 1, {
      langPath: DIGITS_DIR,
      gzip: true,
      cachePath: path.join(process.env.TMPDIR || "/tmp", "docflow-tessdata-eng-best-int"),
      logger: () => {},
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: "7" as never, tessedit_char_whitelist: DIGIT_CHARS, user_defined_dpi: "300" });
    return worker;
  })().catch((e) => {
    globalThis.__dfTesseractDigits = undefined;
    throw e;
  });
  return globalThis.__dfTesseractDigits;
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

/** 切り出したマスの周りに足す余白（px）。文字が端に接していると読めないことがある */
const CROP_PAD = 16;

/** 切り出したマスを読む。結果の単語の位置は、切り出す前の画像の比率に戻す */
async function readCrop(worker: Worker, image: Buffer, size: { width: number; height: number }, job: ReadJob): Promise<ReadOut> {
  const left = Math.max(0, Math.floor(job.box.x * size.width));
  const top = Math.max(0, Math.floor(job.box.y * size.height));
  const width = Math.min(size.width - left, Math.ceil(job.box.w * size.width));
  const height = Math.min(size.height - top, Math.ceil(job.box.h * size.height));
  if (width < 4 || height < 4) return null;
  const crop = await sharp(image)
    .extract({ left, top, width, height })
    .extend({ top: CROP_PAD, bottom: CROP_PAD, left: CROP_PAD, right: CROP_PAD, background: "#ffffff" })
    .png()
    .toBuffer();
  const result = (await worker.recognize(crop, {}, { blocks: true, text: false })) as unknown as TResult;
  const words = wordsOf(result, (b) => ({
    x: (left + b.x0 - CROP_PAD) / size.width,
    y: (top + b.y0 - CROP_PAD) / size.height,
    w: (b.x1 - b.x0) / size.width,
    h: (b.y1 - b.y0) / size.height,
  }));
  if (words.length === 0) return null;
  return { text: words.map((w) => w.text).join(""), conf: Math.min(...words.map((w) => w.conf ?? 0)), box: union(words.map((w) => w.box)) };
}

export class TesseractOcr implements OcrProvider {
  readonly name = "tesseract";
  readonly engine = "tesseract.js 7 / jpn 4.0.0 + eng（数字の読み直し）";

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
      let current = base;
      if (band) {
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
        current = { ...base, words: [...words, ...extra] };
      }
      // 3回目：明細のマスと、自信の低い数字を切り出して読み直す（ocr/refine.ts）
      const jobs = planReads(current);
      if (jobs.length === 0) return current;
      const digits = jobs.some((j) => j.kind === "number") ? await getDigitsWorker() : null;
      const outs: ReadOut[] = [];
      await worker.setParameters({ tessedit_pageseg_mode: "7" as never });
      try {
        for (const job of jobs) outs.push(await readCrop(job.kind === "number" ? (digits as Worker) : worker, image, size, job));
      } finally {
        await worker.setParameters({ tessedit_pageseg_mode: PSM_PAGE as never });
      }
      const refined = applyReads(current, jobs, outs);
      if (process.env.DOCFLOW_OCR_DEBUG) for (const c of refined.changes) console.log(`  読み直し ${c.kind} 「${c.before}」→「${c.after}」 ${c.conf.toFixed(2)}`);
      return { ...refined.page, words: refined.page.words.map((w) => ({ ...w, box: clampBox(w.box) })) };
    });
  }
}
