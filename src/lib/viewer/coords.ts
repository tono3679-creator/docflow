/**
 * 原本の座標（ページ左上 (0,0)〜右下 (1,1) の比率）と、画面の座標（CSS ピクセル）の変換。
 * 表示倍率・ページの大きさ・回転（時計回り 0/90/180/270 度）が変わっても、同じ式で位置を求める。
 * 画面の座標は「回転したあとのページ」の左上が原点。
 */
export type Box = { x: number; y: number; w: number; h: number };
export type Rect = { left: number; top: number; width: number; height: number };
export type Rotation = 0 | 90 | 180 | 270;

export function normalizeRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

/** 回転したあとのページの大きさ（CSS ピクセル）。width・height は回転前のページの大きさ×倍率 */
export function rotatedSize(width: number, height: number, rotation: Rotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

/**
 * 比率の枠 → 画面の四角形。
 *   pageWidth・pageHeight：回転前のページを表示している大きさ（CSS ピクセル。倍率を掛けたもの）
 */
export function toScreenRect(box: Box, pageWidth: number, pageHeight: number, rotation: Rotation = 0): Rect {
  const W = pageWidth;
  const H = pageHeight;
  switch (rotation) {
    case 0:
      return { left: box.x * W, top: box.y * H, width: box.w * W, height: box.h * H };
    case 90:
      return { left: (1 - box.y - box.h) * H, top: box.x * W, width: box.h * H, height: box.w * W };
    case 180:
      return { left: (1 - box.x - box.w) * W, top: (1 - box.y - box.h) * H, width: box.w * W, height: box.h * H };
    case 270:
      return { left: box.y * H, top: (1 - box.x - box.w) * W, width: box.h * H, height: box.w * W };
  }
}

/** 画面の点（回転したあとのページの左上が原点）→ 原本の比率の点 */
export function toNormalizedPoint(px: number, py: number, pageWidth: number, pageHeight: number, rotation: Rotation = 0): { x: number; y: number } {
  const W = pageWidth;
  const H = pageHeight;
  switch (rotation) {
    case 0:
      return { x: px / W, y: py / H };
    case 90:
      return { x: py / W, y: 1 - px / H };
    case 180:
      return { x: 1 - px / W, y: 1 - py / H };
    case 270:
      return { x: 1 - py / W, y: px / H };
  }
}

/** 原本の点がどの枠に入るか（小さい枠を優先。項目の枠が重なっていても、細かい方を選ぶ） */
export function hitTest<T extends { box: Box }>(items: T[], point: { x: number; y: number }, pad = 0.004): T | null {
  const hits = items.filter((i) => point.x >= i.box.x - pad && point.x <= i.box.x + i.box.w + pad && point.y >= i.box.y - pad && point.y <= i.box.y + i.box.h + pad);
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => (a.box.w * a.box.h <= b.box.w * b.box.h ? a : b));
}

/** 枠の周りに少し余白を付けて見やすくする（ページの外には出さない） */
export function padRect(r: Rect, pad: number, bounds: { width: number; height: number }): Rect {
  const left = Math.max(0, r.left - pad);
  const top = Math.max(0, r.top - pad);
  const right = Math.min(bounds.width, r.left + r.width + pad);
  const bottom = Math.min(bounds.height, r.top + r.height + pad);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** 枠が見えるようにするためのスクロール位置（すでに見えていれば null） */
export function scrollToReveal(rect: Rect, offset: { left: number; top: number }, viewport: { scrollLeft: number; scrollTop: number; width: number; height: number }, margin = 48): { left: number; top: number } | null {
  const absLeft = offset.left + rect.left;
  const absTop = offset.top + rect.top;
  const visible = absTop >= viewport.scrollTop + margin / 2 && absTop + rect.height <= viewport.scrollTop + viewport.height - margin / 2
    && absLeft >= viewport.scrollLeft && absLeft + rect.width <= viewport.scrollLeft + viewport.width;
  if (visible) return null;
  return {
    top: Math.max(0, absTop - Math.max(margin, (viewport.height - rect.height) / 3)),
    left: rect.width > viewport.width ? Math.max(0, absLeft - margin / 2) : Math.max(0, absLeft + rect.width / 2 - viewport.width / 2),
  };
}

/** 有効な枠か（座標が分からない項目は印を出さない） */
export function isUsableBox(b: unknown): b is Box {
  if (!b || typeof b !== "object") return false;
  const { x, y, w, h } = b as Record<string, unknown>;
  return [x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v)) && (w as number) > 0 && (h as number) > 0
    && (x as number) >= -0.01 && (y as number) >= -0.01 && (x as number) + (w as number) <= 1.01 && (y as number) + (h as number) <= 1.01;
}
