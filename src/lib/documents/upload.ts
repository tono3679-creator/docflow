import "server-only";
/**
 * アップロードの受付。1ファイルずつ確かめ、問題のあるファイルだけを断る（ほかのファイルは受け付ける）。
 *   1. 大きさ・中身の形式（先頭のバイト）・拡張子・MIME タイプが一致するか
 *   2. PDF：開けるか・パスワード・埋め込みスクリプト・添付ファイル・ページ数
 *      画像：読み込めるか・画素数（展開すると巨大になる画像を断る）
 *   3. ファイル本体を保存し、書類と読取の処理（キュー）を登録する（DB の関数が役割・上限をもう一度確かめる）
 * 読取そのものは worker が行う（アップロードの応答を待たせない）。
 */
import type { CurrentUser } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { basicFileCheck, MIME_BY_TYPE, safeFilename } from "@/lib/extraction/file-type";
import { ImageInspectError, inspectImage } from "@/lib/extraction/image";
import { inspectPdf, PdfInspectError } from "@/lib/extraction/pdf";
import { putFile, sha256 } from "@/lib/storage";
import { toUserMessage } from "@/lib/actions/errors";

export type UploadOutcome =
  | { filename: string; ok: true; documentId: string; duplicateOf: { id: string; filename: string } | null }
  | { filename: string; ok: false; reason: string };

export function maxFileBytes(user: CurrentUser): number {
  return Math.min(user.settings.maxFileMb, serverEnv.uploadBodyLimitMb) * 1024 * 1024;
}

export async function acceptFile(user: CurrentUser, file: { name: string; type: string; bytes: Uint8Array }, batchId: string | null): Promise<UploadOutcome> {
  const filename = safeFilename(file.name);
  const check = basicFileCheck({ bytes: file.bytes, filename, declaredMime: file.type, maxBytes: maxFileBytes(user) });
  if (!check.ok) return { filename, ok: false, reason: check.reason };

  let pageCount = 1;
  try {
    if (check.fileType === "pdf") {
      const info = await inspectPdf(file.bytes);
      if (info.hasScript) return { filename, ok: false, reason: "スクリプトを含む PDF は受け付けていません" };
      if (info.hasAttachments) return { filename, ok: false, reason: "ファイルを添付した PDF は受け付けていません" };
      if (info.pageCount < 1) return { filename, ok: false, reason: "ページがありません" };
      pageCount = info.pageCount;
    } else {
      await inspectImage(file.bytes);
    }
  } catch (e) {
    if (e instanceof PdfInspectError || e instanceof ImageInspectError) return { filename, ok: false, reason: e.message };
    console.error(e);
    return { filename, ok: false, reason: "ファイルを確認できませんでした" };
  }
  if (pageCount > user.settings.maxPages) {
    return { filename, ok: false, reason: `ページ数が多すぎます（${pageCount}ページ・上限 ${user.settings.maxPages}ページ）` };
  }

  const hash = sha256(file.bytes);
  try {
    const mime = MIME_BY_TYPE[check.fileType];
    const path = await putFile(file.bytes, mime, hash);
    return await asUser(user.userId, async (tx) => {
      const [dup] = await tx<{ id: string; filename: string }[]>`
        select id, filename from documents where file_hash = ${hash} order by uploaded_at limit 1`;
      const [row] = await tx<{ id: string }[]>`
        select register_document(${filename}, ${check.fileType}, ${mime}, ${file.bytes.byteLength}, ${path}, ${null},
                                 ${hash}, ${pageCount}, ${batchId}::uuid) id`;
      return { filename, ok: true as const, documentId: row.id, duplicateOf: dup ?? null };
    }, user.organizationId);
  } catch (e) {
    return { filename, ok: false, reason: toUserMessage(e, "登録できませんでした。時間をおいて再度お試しください") };
  }
}

/** デモ環境：1時間にアップロードできる数（OCR の負荷の対策） */
export async function demoUploadAllowed(user: CurrentUser): Promise<boolean> {
  if (!user.isDemo) return true;
  const [row] = await asUser(user.userId, (tx) => tx<{ n: number }[]>`
    select count(*)::int n from documents where not is_sample and uploaded_at > now() - interval '1 hour'`, user.organizationId);
  return row.n < serverEnv.demoUploadLimitPerHour;
}
