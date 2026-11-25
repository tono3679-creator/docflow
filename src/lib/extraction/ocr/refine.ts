/**
 * OCR の読み直し（マスごと）。ページ全体の OCR のあとに、読み違えやすいところだけを切り出して読み直す。
 *   - 明細の表の数量・単価・金額・単位のマス（空のマスも。「1」「式」のような1文字は全体の読み取りで落ちやすい）
 *   - 表の外の、自信の低い数字（小計・合計など）
 * 数字のマスは「数字と , . - / だけ」に絞って読む（「④⑧」「も」「)」のような読み違いが出ない）。
 * 読み直した文字も、原本のその位置から読んだもの。推測で補ったり、計算で埋めたりはしない。
 * 1回目と読み直しが食い違ったときは、自信の高い方を使い、信頼度を「要確認」の水準より下げて人の確認に回す。
 * ここは座標と文字だけを扱う（画像の切り出しと OCR の実行は tesseract.ts）。
 */
import { union } from "../geometry";
import { layoutPage } from "../layout";
import { tableGrid, type ColKey } from "../rules-extractor";
import type { Box, PageText, Word } from "../types";

export type ReadKind = "number" | "unit";
export type ReadJob = { kind: ReadKind; box: Box; words: number[]; column: ColKey | null };
export type ReadOut = { text: string; conf: number; box: Box | null } | null;
export type ReadChange = { kind: ReadKind; before: string; after: string; conf: number; agreed: boolean };

/** 1回目と読み直しが食い違ったときの信頼度の上限（「要確認」の既定の水準 0.8 より下） */
export const DISAGREE_CONF = 0.79;
/** 別々の読み方（ページ全体の読み取りと、数字に絞った読み直し）で同じ値になったときの信頼度の下限 */
export const AGREE_CONF = 0.9;
/** 読み直しの結果を使う信頼度の下限 */
const MIN_CONF = 0.6;
/** これより自信のある、形の正しい読み取りは読み直さない */
const SURE_CONF = 0.93;

const NUMBER_CHARS = /^[0-9,.\-/]+$/;
const TABLE_NUMBER = /^(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?:\.\d{3})+|\d+)(?:\.\d+)?$/;
const UNIT_TEXT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-zー㎡㎏㎝㎜㎞㍑]{1,4}$/u;
/** 数字に単位が付いたもの（「3台」「2箱」）。数字だけに絞って読むと単位の文字が数字に化けるので、読み直さない */
const NUMBER_WITH_UNIT = /^\d[\d,.]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]+$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** よく使う単位。これに当たる読み直しは、信頼度がやや低くても使う（ただし「要確認」のまま） */
const KNOWN_UNIT = /^(一?式|個|本|枚|点|台|箱|巻|袋|冊|部|組|セット|件|回|時間|日|月|ヶ月|か月|人|名|缶|瓶|束|足|着|箇所|ヶ所|か所|食|杯|泊|室|便|口|個口|ケース|パック|ロール|丁|脚|基|機|面|坪|㎡|㎥|kg|g|m|cm|mm|L|ml|pcs)$/i;
const MIN_UNIT_CONF_KNOWN = 0.4;

function wellFormed(kind: ReadKind, text: string, inTable: boolean): boolean {
  if (kind === "unit") return UNIT_TEXT.test(text);
  if (inTable) return TABLE_NUMBER.test(text);
  return NUMBER_CHARS.test(text) && /\d/.test(text) && !/^[,.]|[,.]$/.test(text);
}

const minConf = (words: Word[]) => words.reduce((m, w) => Math.min(m, w.conf ?? 1), 1);

/** 読み直す場所を決める */
export function planReads(page: PageText): ReadJob[] {
  if (page.source !== "ocr" || page.words.length === 0) return [];
  const lp = layoutPage(page);
  const aspect = page.height / page.width;
  const jobs: ReadJob[] = [];
  const inTable = new Set<number>();
  const grid = tableGrid(lp);
  if (grid) {
    for (const l of grid.headerLines) for (const wi of l.charWord) if (wi >= 0) inTable.add(wi);
    for (const row of grid.rows) {
      const rowWords = [...new Set(row.lines.flatMap((l) => l.charWord.filter((w) => w >= 0)))];
      for (const wi of rowWords) inTable.add(wi);
      const h = row.bottom - row.top;
      // 品名だけの行（品名の2行目）は読み直さない
      const numericRow = [...row.cells.entries()].some(([k, c]) => k !== "description" && k !== "unit" && /\d/.test(c.text));
      if (!numericRow && row.cells.has("description")) continue;
      for (const col of grid.columns) {
        if (col.key !== "quantity" && col.key !== "unit_price" && col.key !== "amount" && col.key !== "unit") continue;
        const kind: ReadKind = col.key === "unit" ? "unit" : "number";
        const cell = row.cells.get(col.key);
        const words = cell?.words ?? [];
        const text = cell?.text ?? "";
        const ws = words.map((i) => page.words[i]);
        if (words.length > 0) {
          if (wellFormed(kind, text, true) && minConf(ws) >= SURE_CONF) continue;
          if (kind === "number" && NUMBER_WITH_UNIT.test(text)) continue;
          // 「一式」「別途」のような文字の記載は、数字に絞って読み直さない
          if (kind === "number" && CJK.test(text) && minConf(ws) >= 0.8) continue;
          if (kind === "unit" && /\d/.test(text)) continue;
          const b = union(ws.map((w) => w.box)) as Box;
          const padX = h * aspect * 0.5;
          const left = Math.max(col.left, b.x - padX);
          const right = Math.min(col.right, b.x + b.w + padX);
          jobs.push({ kind, column: col.key, words, box: { x: left, y: row.top - h * 0.3, w: right - left, h: h * 1.6 } });
        } else {
          // 空のマス：列の範囲から、となりの列の単語がはみ出しているところを除く
          let left = col.left;
          let right = col.right;
          const mid = (left + right) / 2;
          for (const wi of rowWords) {
            const wb = page.words[wi].box;
            if (wb.x + wb.w <= left || wb.x >= right) continue;
            if (wb.x + wb.w / 2 < mid) left = Math.max(left, wb.x + wb.w + h * aspect * 0.2);
            else right = Math.min(right, wb.x - h * aspect * 0.2);
          }
          if (right - left < h * aspect * 0.8) continue;
          jobs.push({ kind, column: col.key, words: [], box: { x: left, y: row.top - h * 0.3, w: right - left, h: h * 1.6 } });
        }
      }
    }
  }
  // 表の外の数字：同じ行で続いている数字だけの単語のまとまり（「66,」「000」）で、自信の低いもの
  for (const line of lp.lines) {
    const order = [...new Set(line.charWord.filter((w) => w >= 0))];
    let group: number[] = [];
    const flush = () => {
      if (group.length > 0) {
        const ws = group.map((i) => page.words[i]);
        const text = group.map((i) => lp.normWords[i]).join("");
        if (/\d/.test(text) && text.replace(/\D/g, "").length >= 2 && minConf(ws) < SURE_CONF) {
          const b = union(ws.map((w) => w.box)) as Box;
          const padX = b.h * aspect * 0.4;
          jobs.push({ kind: "number", column: null, words: [...group], box: { x: b.x - padX, y: b.y - b.h * 0.3, w: b.w + padX * 2, h: b.h * 1.6 } });
        }
      }
      group = [];
    };
    for (const wi of order) {
      if (inTable.has(wi) || !NUMBER_CHARS.test(lp.normWords[wi])) flush();
      else group.push(wi);
    }
    flush();
  }
  return jobs.map((j) => ({ ...j, box: clip(j.box) }));
}

function clip(b: Box): Box {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, w: Math.max(0, Math.min(1, b.x + b.w) - x), h: Math.max(0, Math.min(1, b.y + b.h) - y) };
}

/** 数字の読み取りが同じ値か（「11.200」と「11,200」のような区切りの違いは同じとみなす） */
function sameNumber(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (t: string) => (/^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, ",") : t);
  return norm(a) === norm(b);
}

/**
 * 読み直しの結果を単語に反映する。
 *   - 2回の読み取りが同じ値：そのまま（区切りの「.」「,」の違いは読み直しの方に）。別々の読み方で一致したので信頼度を AGREE_CONF 以上に
 *   - 1回目が空・形が正しくない（「)」「:」「48,.000」）：読み直しを使う
 *   - どちらも形は正しいのに違う値：読み直しを使い、信頼度を下げて人の確認に回す
 * 数字だけに絞った読み直しは、文字の形が崩れていても数字として読めるかわりに、信頼度の数字が当てにならない
 * （正しく読めても 0 に近いことがある）。そのため、使うかどうかは値の形（桁区切り・桁数）で決める。
 */
export function applyReads(page: PageText, jobs: ReadJob[], outs: ReadOut[]): { page: PageText; changes: ReadChange[] } {
  const lp = layoutPage(page);
  const removed = new Set<number>();
  const added: Word[] = [];
  const confOf = new Map<number, number>();
  const changes: ReadChange[] = [];
  jobs.forEach((job, i) => {
    const out = outs[i];
    if (!out) return;
    const text = out.text.replace(/\s+/g, "");
    const inTable = job.column !== null;
    if (!text || !wellFormed(job.kind, text, inTable)) return;
    // 単位（日本語の文字）は信頼度が当てになるので、低いものは使わない
    if (job.kind === "unit" && out.conf < (KNOWN_UNIT.test(text) ? MIN_UNIT_CONF_KNOWN : MIN_CONF)) return;
    const ws = job.words.map((w) => page.words[w]);
    const before = job.words.map((w) => lp.normWords[w]).join("");
    const beforeConf = ws.length ? minConf(ws) : 0;
    const box = out.box ?? (ws.length ? union(ws.map((w) => w.box)) : null);
    if (!box) return;
    const beforeOk = ws.length > 0 && wellFormed(job.kind, before, inTable);
    // 表の外の数字は、桁の数が変わる読み直しは使わない（となりの文字を巻き込んだ・取りこぼしたおそれ）
    if (!inTable && before.replace(/\D/g, "").length !== text.replace(/\D/g, "").length) return;
    let conf: number;
    let agreed = false;
    if (beforeOk && sameNumber(before, text)) {
      conf = Math.max(beforeConf, AGREE_CONF);
      if (before === text) {
        for (const w of job.words) confOf.set(w, Math.max(page.words[w].conf ?? 0, conf));
        return;
      }
      agreed = true;
    } else if (beforeOk) {
      conf = DISAGREE_CONF;
    } else if (job.kind === "unit") {
      conf = out.conf >= 0.9 ? out.conf : Math.min(out.conf, DISAGREE_CONF);
    } else {
      conf = out.conf >= 0.9 ? out.conf : DISAGREE_CONF;
    }
    for (const w of job.words) removed.add(w);
    added.push({ text, box, conf });
    changes.push({ kind: job.kind, before, after: text, conf, agreed });
  });
  const words = page.words.map((w, i) => (confOf.has(i) ? { ...w, conf: confOf.get(i) as number } : w)).filter((_, i) => !removed.has(i));
  return { page: { ...page, words: [...words, ...added] }, changes };
}
