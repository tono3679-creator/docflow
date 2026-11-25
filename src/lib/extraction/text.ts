/**
 * 文字の整形。OCR・PDF の文字・利用者の入力を同じ形にそろえて比べる。
 *   全角英数 → 半角（NFKC）、円記号の揺れ（\ ￥）→ ¥、日本語どうしの間の空白は除く
 */
const CJK = /[　-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;

export function isCjk(ch: string): boolean {
  return CJK.test(ch);
}

export function normalizeChars(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\\￥]/g, "¥")
    .replace(/[‐‑‒–—―ー](?=\d)/g, (m, offset: number, all: string) => (offset > 0 && /[A-Za-z0-9]/.test(all[offset - 1]) ? "-" : m))
    .replace(/[​-‍﻿]/g, "");
}

/** 1行の文字の整形（日本語の文字の間の空白を除き、連続する空白を1つに） */
export function normalizeText(s: string): string {
  const t = normalizeChars(s).replace(/\s+/g, " ").trim();
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === " ") {
      const prev = out[out.length - 1] ?? "";
      const next = t[i + 1] ?? "";
      if (isCjk(prev) || isCjk(next)) continue;
    }
    out += ch;
  }
  return out;
}

/** 比較用（空白・区切りを除く） */
export function compactKey(s: string): string {
  return normalizeText(s).replace(/[\s・,，.。:：()（）「」\-‐]/g, "").toLowerCase();
}

/** 文字の幅の目安（全角 1、半角 0.5）。単語の中の一部の位置を求めるのに使う */
export function charWeight(ch: string): number {
  return /[\u0000-ÿ｡-ﾟ]/.test(ch) ? 0.55 : 1;
}

/** 日本語の文字どうしの間の空白（OCR が語の区切りとして入れたもの）だけを除く。「緑茶 500ml」の空白は残す */
export function tidySpaces(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  let out = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === " " && isCjk(out[out.length - 1] ?? "") && isCjk(t[i + 1] ?? "")) continue;
    out += t[i];
  }
  return out;
}
