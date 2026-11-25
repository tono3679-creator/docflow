import type { Box } from "./types";

export function union(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 比率の範囲（0〜1）に収め、小数を丸める（保存の大きさを抑える） */
export function clampBox(b: Box): Box {
  const r = (n: number) => Math.round(n * 100000) / 100000;
  const x = Math.min(Math.max(b.x, 0), 1);
  const y = Math.min(Math.max(b.y, 0), 1);
  return { x: r(x), y: r(y), w: r(Math.min(Math.max(b.w, 0), 1 - x)), h: r(Math.min(Math.max(b.h, 0), 1 - y)) };
}

export function isValidBox(b: unknown): b is Box {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!ok(o.x) || !ok(o.y) || !ok(o.w) || !ok(o.h)) return false;
  const { x, y, w, h } = o as Box;
  return x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1.0001 && y + h <= 1.0001;
}

/** 縦方向の重なり（小さい方の高さに対する割合） */
export function verticalOverlap(a: Box, b: Box): number {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, bottom - top);
  return overlap / Math.max(1e-9, Math.min(a.h, b.h));
}

export function horizontalOverlap(a: Box, b: Box): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  return Math.max(0, right - left) / Math.max(1e-9, Math.min(a.w, b.w));
}

export const centerX = (b: Box) => b.x + b.w / 2;
export const centerY = (b: Box) => b.y + b.h / 2;
