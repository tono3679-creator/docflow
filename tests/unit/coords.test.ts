/**
 * 原本の印の座標（src/lib/viewer/coords.ts）。
 * 画像は CSS の translate(...) rotate(...)（左上を軸）で、PDF は pdf.js の viewport の回転で表示する。
 * どちらも時計回りなので、CSS と同じ行列で角を変換した結果と、toScreenRect が一致することを確かめる。
 */
import { describe, expect, it } from "vitest";
import { hitTest, isUsableBox, normalizeRotation, padRect, rotatedSize, scrollToReveal, toNormalizedPoint, toScreenRect, type Box, type Rotation } from "@/lib/viewer/coords";

const ROTATIONS: Rotation[] = [0, 90, 180, 270];
const ZOOMS = [0.5, 1, 1.37, 2, 3];

/** document-viewer.tsx の RotatedImage と同じ変換（translate → rotate、原点は左上、y は下向き） */
function cssTransform(u: number, v: number, W: number, H: number, rot: Rotation): [number, number] {
  const [tx, ty] = rot === 90 ? [H, 0] : rot === 180 ? [W, H] : rot === 270 ? [0, W] : [0, 0];
  const rad = (rot * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  return [tx + cos * u - sin * v, ty + sin * u + cos * v];
}

function boundsOf(points: [number, number][]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

const BOXES: Box[] = [
  { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0.72, y: 0.9, w: 0.2, h: 0.04 },
];

describe("toScreenRect", () => {
  for (const rot of ROTATIONS) {
    for (const zoom of ZOOMS) {
      it(`回転 ${rot}°・倍率 ${zoom} で、表示した画像の同じ位置に重なる`, () => {
        const W = 595 * zoom;
        const H = 842 * zoom;
        for (const b of BOXES) {
          const corners: [number, number][] = [
            [b.x * W, b.y * H], [(b.x + b.w) * W, b.y * H], [b.x * W, (b.y + b.h) * H], [(b.x + b.w) * W, (b.y + b.h) * H],
          ].map(([u, v]) => cssTransform(u, v, W, H, rot));
          const expected = boundsOf(corners);
          const got = toScreenRect(b, W, H, rot);
          expect(got.left).toBeCloseTo(expected.left, 6);
          expect(got.top).toBeCloseTo(expected.top, 6);
          expect(got.width).toBeCloseTo(expected.width, 6);
          expect(got.height).toBeCloseTo(expected.height, 6);
        }
      });
    }
  }

  it("回転した枠はページ（回転後の大きさ）の中に収まる", () => {
    for (const rot of ROTATIONS) {
      const size = rotatedSize(600, 800, rot);
      for (const b of BOXES) {
        const r = toScreenRect(b, 600, 800, rot);
        expect(r.left).toBeGreaterThanOrEqual(-1e-9);
        expect(r.top).toBeGreaterThanOrEqual(-1e-9);
        expect(r.left + r.width).toBeLessThanOrEqual(size.width + 1e-9);
        expect(r.top + r.height).toBeLessThanOrEqual(size.height + 1e-9);
      }
    }
  });
});

describe("toNormalizedPoint（原本を押した位置 → 項目）", () => {
  for (const rot of ROTATIONS) {
    it(`回転 ${rot}° でも、枠の中心を押すと元の比率の中心に戻る`, () => {
      for (const zoom of ZOOMS) {
        const W = 600 * zoom;
        const H = 850 * zoom;
        for (const b of BOXES) {
          const r = toScreenRect(b, W, H, rot);
          const p = toNormalizedPoint(r.left + r.width / 2, r.top + r.height / 2, W, H, rot);
          expect(p.x).toBeCloseTo(b.x + b.w / 2, 6);
          expect(p.y).toBeCloseTo(b.y + b.h / 2, 6);
        }
      }
    });
  }
});

describe("hitTest", () => {
  const items = [
    { id: "row", box: { x: 0.1, y: 0.5, w: 0.8, h: 0.03 } },
    { id: "amount", box: { x: 0.7, y: 0.505, w: 0.15, h: 0.02 } },
  ];
  it("重なっているときは小さい枠（細かい項目）を選ぶ", () => {
    expect(hitTest(items, { x: 0.75, y: 0.51 })?.id).toBe("amount");
    expect(hitTest(items, { x: 0.2, y: 0.51 })?.id).toBe("row");
  });
  it("どの枠にも入らなければ選ばない", () => {
    expect(hitTest(items, { x: 0.5, y: 0.1 })).toBeNull();
  });
});

describe("そのほか", () => {
  it("回転の角度をそろえる", () => {
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
  });
  it("90°・270° は縦横が入れ替わる", () => {
    expect(rotatedSize(100, 200, 90)).toEqual({ width: 200, height: 100 });
    expect(rotatedSize(100, 200, 180)).toEqual({ width: 100, height: 200 });
  });
  it("余白を付けてもページの外に出ない", () => {
    expect(padRect({ left: 1, top: 1, width: 10, height: 10 }, 4, { width: 12, height: 100 })).toEqual({ left: 0, top: 0, width: 12, height: 15 });
  });
  it("座標が分からない・壊れた枠には印を出さない", () => {
    expect(isUsableBox(null)).toBe(false);
    expect(isUsableBox({ x: 0.1, y: 0.1, w: 0, h: 0.1 })).toBe(false);
    expect(isUsableBox({ x: Number.NaN, y: 0.1, w: 0.1, h: 0.1 })).toBe(false);
    expect(isUsableBox({ x: 0.95, y: 0.1, w: 0.2, h: 0.1 })).toBe(false);
    expect(isUsableBox({ x: "0.1", y: 0.1, w: 0.1, h: 0.1 })).toBe(false);
    expect(isUsableBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 })).toBe(true);
  });
  it("見えている枠ならスクロールしない／見えていなければ枠が見える位置へ", () => {
    const vp = { scrollLeft: 0, scrollTop: 0, width: 800, height: 600 };
    expect(scrollToReveal({ left: 10, top: 100, width: 50, height: 20 }, { left: 16, top: 16 }, vp)).toBeNull();
    const t = scrollToReveal({ left: 10, top: 2000, width: 50, height: 20 }, { left: 16, top: 16 }, vp);
    expect(t).not.toBeNull();
    expect(t!.top).toBeLessThan(2016);
    expect(t!.top + 600).toBeGreaterThan(2036);
  });
});
