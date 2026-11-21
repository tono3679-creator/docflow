/**
 * 書類種別の判定（ルール）。見出し（大きな文字）・記載項目・定型の文言から得点を付け、
 * 1位が十分な得点で、2位との差もあるときだけ種別を決める。決めきれなければ「不明」（無理に分類しない）。
 */
import type { LayoutPage } from "./layout";
import type { ClassificationResult, DocumentType } from "./types";

type Known = Exclude<DocumentType, "unknown">;

const TITLE: Record<Known, RegExp> = {
  invoice: /(御?請求書|INVOICE|請求明細書)/i,
  receipt: /(領収書|領収証|RECEIPT|レシート)/i,
  delivery_note: /(納品書|納品明細書|DELIVERY)/i,
};

const KEYWORDS: Record<Known, { re: RegExp; score: number; label: string }[]> = {
  invoice: [
    { re: /ご?請求金額/, score: 3, label: "請求金額" },
    { re: /請求(書)?(番号|No)/i, score: 2, label: "請求番号" },
    { re: /(お)?支払(い)?期(限|日)|お振込期限/, score: 2, label: "支払期限" },
    { re: /(お)?振込先|振込口座/, score: 2, label: "振込先" },
    { re: /下記の(とおり|通り)ご?請求/, score: 3, label: "請求の文言" },
  ],
  receipt: [
    { re: /上記(正に|まさに)?領収/, score: 4, label: "領収の文言" },
    { re: /但し|但し書/, score: 2, label: "但し書き" },
    { re: /領収金額/, score: 3, label: "領収金額" },
    { re: /お預かり|お釣り|おつり/, score: 2, label: "預かり・釣り" },
    { re: /収入印紙/, score: 1, label: "収入印紙" },
  ],
  delivery_note: [
    { re: /納品日/, score: 3, label: "納品日" },
    { re: /納品(書)?(番号|No)/i, score: 2, label: "納品書番号" },
    { re: /下記の(とおり|通り)(ご)?納品/, score: 3, label: "納品の文言" },
    { re: /納品先|お届け先/, score: 2, label: "納品先" },
    { re: /受領印/, score: 2, label: "受領印" },
  ],
};

/** 3種類以外の書類の見出し（見積書など）。これが見出しなら不明にする */
const OTHER_TITLE = /(見積書|注文書|発注書|契約書|請求書在中|納品請求書)/;

export function classifyDocument(pages: LayoutPage[]): ClassificationResult {
  const scores: Record<Known, number> = { invoice: 0, receipt: 0, delivery_note: 0 };
  const evidence: string[] = [];
  const first = pages[0];
  if (!first || first.lines.length === 0) {
    return { type: "unknown", scores, evidence: ["文字がありません"], method: "rules" };
  }
  // 見出し：1ページ目の上 35% にある、いちばん大きな文字の行
  const top = first.lines.filter((l) => l.box.y < 0.35);
  const maxH = Math.max(...top.map((l) => l.box.h), 0);
  const titles = top.filter((l) => l.box.h >= maxH * 0.8);
  let otherTitle = false;
  for (const t of titles) {
    const text = t.text.replace(/\s/g, "");
    if (OTHER_TITLE.test(text)) otherTitle = true;
    for (const k of Object.keys(TITLE) as Known[]) {
      if (TITLE[k].test(text)) {
        scores[k] += 6;
        evidence.push(`見出し「${text.slice(0, 20)}」`);
      }
    }
  }
  const all = pages.flatMap((p) => p.lines.map((l) => l.text.replace(/\s/g, ""))).join("\n");
  for (const k of Object.keys(KEYWORDS) as Known[]) {
    // 見出し以外の場所に書かれた書類名
    if (scores[k] === 0 && TITLE[k].test(all)) {
      scores[k] += 2;
      evidence.push(`「${TITLE[k].exec(all)?.[0]}」の記載`);
    }
    for (const kw of KEYWORDS[k]) {
      if (kw.re.test(all)) {
        scores[k] += kw.score;
        evidence.push(kw.label);
      }
    }
  }
  const ranked = (Object.entries(scores) as [Known, number][]).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  let type: DocumentType = "unknown";
  if (!otherTitle && best[1] >= 5 && best[1] - second[1] >= 3) type = best[0];
  if (otherTitle) evidence.push("請求書・領収書・納品書以外の見出し");
  return { type, scores, evidence: [...new Set(evidence)], method: "rules" };
}
