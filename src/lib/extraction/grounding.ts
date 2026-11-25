/**
 * 値と原本の位置の対応付け。
 * 原本の文字（source_text）を、指定された行 → 書類全体 の順に探し、ちょうど1か所で見つかったときだけ位置を返す。
 * 見つからない・複数の場所に同じ文字がある（どれか決められない）ときは null（間違った場所を示さない）。
 */
import { rangeSource, type LayoutPage } from "./layout";
import { normalizeText } from "./text";
import type { Line, SourceRef } from "./types";

type Hit = { lp: LayoutPage; line: Line; start: number; end: number };

function compactWithMap(text: string): { compact: string; map: number[] } {
  let compact = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " ") continue;
    compact += text[i];
    map.push(i);
  }
  return { compact, map };
}

function findHits(pages: LayoutPage[], needle: string, lineIds: Set<string> | null): Hit[] {
  const n = compactWithMap(normalizeText(needle)).compact;
  if (n.length === 0) return [];
  const hits: Hit[] = [];
  for (const lp of pages) {
    for (const line of lp.lines) {
      if (lineIds && !lineIds.has(line.id)) continue;
      const { compact, map } = compactWithMap(line.text);
      let from = 0;
      for (;;) {
        const at = compact.indexOf(n, from);
        if (at < 0) break;
        hits.push({ lp, line, start: map[at], end: map[at + n.length - 1] + 1 });
        from = at + 1;
      }
    }
  }
  return hits;
}

export function groundText(pages: LayoutPage[], sourceText: string | null, lineIds: string[]): SourceRef | null {
  if (!sourceText || !sourceText.trim()) return null;
  const cited = lineIds.length > 0 ? findHits(pages, sourceText, new Set(lineIds)) : [];
  const hits = cited.length > 0 ? cited : findHits(pages, sourceText, null);
  if (hits.length !== 1) return null;
  const h = hits[0];
  const r = rangeSource(h.lp, h.line, h.start, h.end);
  if (!r) return null;
  return { page: h.lp.page.page, box: r.box, text: h.line.text.slice(h.start, h.end), conf: r.conf };
}

/** 根拠の文字が書類の中に何か所あるか（0 なら書類に無い値＝推測の疑い） */
export function countOccurrences(pages: LayoutPage[], sourceText: string | null): number {
  if (!sourceText || !sourceText.trim()) return 0;
  return findHits(pages, sourceText, null).length;
}
