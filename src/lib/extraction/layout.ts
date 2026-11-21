/**
 * 単語を「行」にまとめる（PDF の文字情報・OCR の結果のどちらにも使う）。
 *   1. 縦の位置が重なる単語を同じ「段」（表の1行）にまとめる
 *   2. 段の中で、間が大きく空いたところで区切って「行」にする（表の列・ラベルと値の離れた配置）
 * 行の文字の1文字ずつに、元の単語と単語内の位置を持たせる（値の文字から原本の座標を求めるため）。
 */
import { centerY, union, verticalOverlap } from "./geometry";
import { charWeight, normalizeChars } from "./text";
import type { Box, Line, PageText, Word } from "./types";

export type LayoutPage = { page: PageText; normWords: string[]; lines: Line[] };

const ALNUM = /[A-Za-z0-9¥$%.,\-/]/;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function layoutPage(page: PageText, options: { gapFactor?: number } = {}): LayoutPage {
  const gapFactor = options.gapFactor ?? 1.6;
  const normWords = page.words.map((w) => normalizeChars(w.text).replace(/\s+/g, ""));
  const idx = page.words.map((_, i) => i).filter((i) => normWords[i].length > 0 && page.words[i].box.h > 0);
  // 縦横比を考えて、ページの高さを基準にした文字の高さ（比率）で比べる
  const aspect = page.width / page.height;
  idx.sort((a, b) => centerY(page.words[a].box) - centerY(page.words[b].box));

  type Row = { box: Box; members: number[] };
  const rows: Row[] = [];
  for (const i of idx) {
    const b = page.words[i].box;
    let target: Row | undefined;
    for (let r = rows.length - 1; r >= 0 && r >= rows.length - 4; r--) {
      const row = rows[r];
      const dy = Math.abs(centerY(row.box) - centerY(b));
      if (verticalOverlap(row.box, b) >= 0.5 && dy < 0.6 * Math.max(row.box.h, b.h)) {
        target = row;
        break;
      }
    }
    if (target) {
      target.members.push(i);
      target.box = union([target.box, b]) as Box;
    } else {
      rows.push({ box: b, members: [i] });
    }
  }

  const lines: Line[] = [];
  rows.forEach((row, rowIndex) => {
    const members = [...row.members].sort((a, b) => page.words[a].box.x - page.words[b].box.x);
    // 文字の高さ（横の比率に直す）
    const hs = members.map((i) => page.words[i].box.h / aspect);
    const charH = median(hs) || 0.01;
    let segment: number[] = [];
    const flush = () => {
      if (segment.length > 0) lines.push(buildLine(page, normWords, segment, rowIndex, lines.length, charH));
      segment = [];
    };
    for (const i of members) {
      if (segment.length > 0) {
        const prev = page.words[segment[segment.length - 1]].box;
        const gap = page.words[i].box.x - (prev.x + prev.w);
        if (gap > gapFactor * charH) flush();
      }
      segment.push(i);
    }
    flush();
  });
  return { page, normWords, lines };
}

function buildLine(page: PageText, normWords: string[], members: number[], row: number, n: number, charH: number): Line {
  let text = "";
  const charWord: number[] = [];
  const charOffset: number[] = [];
  members.forEach((wi, k) => {
    const t = normWords[wi];
    if (k > 0) {
      const prev = page.words[members[k - 1]].box;
      const gap = page.words[wi].box.x - (prev.x + prev.w);
      const last = text[text.length - 1] ?? "";
      if (gap > 0.45 * charH || (ALNUM.test(last) && ALNUM.test(t[0]) && gap > 0.15 * charH)) {
        text += " ";
        charWord.push(-1);
        charOffset.push(-1);
      }
    }
    for (let c = 0; c < t.length; c++) {
      text += t[c];
      charWord.push(wi);
      charOffset.push(c);
    }
  });
  return {
    id: `p${page.page}-l${n}`,
    page: page.page,
    text,
    box: union(members.map((i) => page.words[i].box)) as Box,
    charWord,
    charOffset,
    row,
  };
}

/** 単語の中の一部（from〜to 文字目）の位置。文字の幅の目安（全角・半角）で按分する */
export function subBox(word: Word, normText: string, from: number, to: number): Box {
  if (from <= 0 && to >= normText.length) return word.box;
  const weights = [...normText].map(charWeight);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const before = weights.slice(0, from).reduce((a, b) => a + b, 0);
  const inside = weights.slice(from, to).reduce((a, b) => a + b, 0);
  return { x: word.box.x + (word.box.w * before) / total, y: word.box.y, w: (word.box.w * inside) / total, h: word.box.h };
}

/** 行の文字の範囲（start〜end）に対応する原本の位置と、その文字の最低の信頼度 */
export function rangeSource(lp: LayoutPage, line: Line, start: number, end: number): { box: Box; conf: number | null } | null {
  const perWord = new Map<number, { from: number; to: number }>();
  for (let c = Math.max(0, start); c < Math.min(end, line.text.length); c++) {
    const wi = line.charWord[c];
    if (wi < 0) continue;
    const off = line.charOffset[c];
    const cur = perWord.get(wi);
    if (!cur) perWord.set(wi, { from: off, to: off + 1 });
    else {
      cur.from = Math.min(cur.from, off);
      cur.to = Math.max(cur.to, off + 1);
    }
  }
  if (perWord.size === 0) return null;
  const boxes: Box[] = [];
  let conf: number | null = null;
  for (const [wi, r] of perWord) {
    const w = lp.page.words[wi];
    boxes.push(subBox(w, lp.normWords[wi], r.from, r.to));
    if (w.conf !== null) conf = conf === null ? w.conf : Math.min(conf, w.conf);
  }
  const box = union(boxes);
  return box ? { box, conf } : null;
}
