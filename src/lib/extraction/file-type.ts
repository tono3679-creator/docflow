/**
 * ファイル形式の判定（拡張子や申告された MIME タイプではなく、ファイルの先頭の内容で判定する）。
 */
export type FileType = "pdf" | "png" | "jpeg" | "webp";

export const MIME_BY_TYPE: Record<FileType, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const EXTENSIONS: Record<FileType, string[]> = {
  pdf: ["pdf"],
  png: ["png"],
  jpeg: ["jpg", "jpeg"],
  webp: ["webp"],
};

export function detectFileType(bytes: Uint8Array): FileType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  // PDF は先頭 1KB 以内に %PDF- があればよい（仕様上の許容）
  const head = ascii(b, 0, Math.min(1024, b.length));
  if (head.includes("%PDF-")) return "pdf";
  return null;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  return m ? m[1].toLowerCase() : "";
}

export type BasicCheck = { ok: true; fileType: FileType } | { ok: false; reason: string };

/** 形式・拡張子・MIME タイプ・大きさの確認（中身の解析の前に行う） */
export function basicFileCheck(input: { bytes: Uint8Array; filename: string; declaredMime: string; maxBytes: number }): BasicCheck {
  if (input.bytes.length === 0) return { ok: false, reason: "空のファイルです" };
  if (input.bytes.length > input.maxBytes) {
    return { ok: false, reason: `ファイルが大きすぎます（上限 ${Math.round(input.maxBytes / 1024 / 1024)}MB）` };
  }
  const detected = detectFileType(input.bytes);
  if (!detected) return { ok: false, reason: "対応していない形式です（PDF・PNG・JPEG・WebP）" };
  const ext = extensionOf(input.filename);
  if (!EXTENSIONS[detected].includes(ext)) {
    return { ok: false, reason: `拡張子と中身の形式が一致しません（中身は ${detected.toUpperCase()}）` };
  }
  const declared = input.declaredMime.toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== MIME_BY_TYPE[detected] && !(detected === "jpeg" && declared === "image/jpg")) {
    return { ok: false, reason: "ファイルの種類の情報と中身が一致しません" };
  }
  return { ok: true, fileType: detected };
}

/** ファイル名を安全な形に（パス区切り・制御文字を除く） */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().slice(0, 200);
  return cleaned || "file";
}
