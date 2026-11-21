import "server-only";
/**
 * 画像の整形（サーバー）。
 * 写真の向き（EXIF）を直し、メタデータ（位置情報など）を消した PNG にする。表示もこの PNG を使うので、座標がずれない。
 * 大きすぎる画像（展開すると巨大になるもの）は読み込まない。
 */
import sharp from "sharp";

export const MAX_INPUT_PIXELS = 40_000_000;
const MAX_SIDE = 3000;

export class ImageInspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageInspectError";
  }
}

export async function normalizeImage(bytes: Uint8Array): Promise<{ png: Buffer; width: number; height: number }> {
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (/pixel limit/i.test(message)) throw new ImageInspectError("画像が大きすぎます（4,000万画素まで）");
    throw new ImageInspectError("画像を読み込めません（ファイルが壊れている可能性があります）");
  }
}

/** アップロードの確認：画像として読めるか・大きすぎないか（中身の変換はしない） */
export async function inspectImage(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  try {
    const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
    if (!meta.width || !meta.height) throw new Error("size");
    if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new ImageInspectError("画像が大きすぎます（4,000万画素まで）");
    if ((meta.pages ?? 1) > 1) throw new ImageInspectError("複数ページ（アニメーション）の画像は読み取れません");
    // 実際に1回読み込んで、壊れていないか確かめる（小さく縮めるだけ）
    await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).resize(64, 64, { fit: "inside" }).toBuffer();
    return { width: meta.width, height: meta.height };
  } catch (e) {
    if (e instanceof ImageInspectError) throw e;
    const message = e instanceof Error ? e.message : "";
    if (/pixel limit/i.test(message)) throw new ImageInspectError("画像が大きすぎます（4,000万画素まで）");
    throw new ImageInspectError("画像を読み込めません（ファイルが壊れている可能性があります）");
  }
}

/** OCR の前に、小さい画像を拡大する（長い辺 2400px 程度で数字の読み違いが大きく減る）。座標は比率なので表示用の画像と同じ */
export async function upscaleForOcr(img: { png: Buffer; width: number; height: number }, minLongSide = 2400): Promise<{ png: Buffer; width: number; height: number }> {
  const long = Math.max(img.width, img.height);
  if (long >= minLongSide) return img;
  const scale = minLongSide / long;
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);
  const png = await sharp(img.png).resize({ width, height, kernel: "lanczos3" }).png({ compressionLevel: 3 }).toBuffer();
  return { png, width, height };
}
