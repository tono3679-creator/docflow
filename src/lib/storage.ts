import "server-only";
/**
 * 書類のファイル本体の保存先。
 *   既定：DB の app_private.file_blobs（内容の SHA-256 で1つだけ保存。ログイン利用者からは直接読めない）
 *   任意：Supabase Storage の非公開バケット documents（SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定したとき）
 * 保存先の名前（storage_path）は 'db:<sha256>' または 'supabase:documents/<sha256>'。
 * 取り出すのはサーバーだけ。画面からは /api/documents/[id]/file を通し、書類を RLS 付きで読めたときだけ返す。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { storageEnv } from "@/lib/env";

const BUCKET = "documents";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** ファイルを保存して、保存先の名前を返す（同じ内容が既にあればそれを使う） */
export async function putFile(bytes: Uint8Array, mimeType: string, hash = sha256(bytes)): Promise<string> {
  if (storageEnv.enabled) {
    const res = await fetch(`${storageEnv.url}/storage/v1/object/${BUCKET}/${hash}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${storageEnv.serviceRoleKey}`,
        "content-type": mimeType,
        "x-upsert": "true",
      },
      body: Buffer.from(bytes),
    });
    if (!res.ok) throw new Error(`ファイルを保存できませんでした（Storage ${res.status}）`);
    return `supabase:${BUCKET}/${hash}`;
  }
  await db()`insert into app_private.file_blobs (sha256, content, byte_size, mime_type)
             values (${hash}, ${Buffer.from(bytes)}, ${bytes.byteLength}, ${mimeType})
             on conflict (sha256) do nothing`;
  return `db:${hash}`;
}

/** 保存先の名前からファイルを取り出す（呼ぶ前に、利用者がその書類を読めることを確かめておく） */
export async function getFile(path: string): Promise<Buffer> {
  if (path.startsWith("db:")) {
    const [row] = await db()<{ content: Buffer }[]>`select content from app_private.file_blobs where sha256 = ${path.slice(3)}`;
    if (!row) throw new Error("ファイルが見つかりません");
    return Buffer.from(row.content);
  }
  if (path.startsWith("supabase:")) {
    const res = await fetch(`${storageEnv.url}/storage/v1/object/authenticated/${path.slice("supabase:".length)}`, {
      headers: { authorization: `Bearer ${storageEnv.serviceRoleKey}` },
    });
    if (!res.ok) throw new Error(`ファイルを取り出せませんでした（Storage ${res.status}）`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("保存先の形式が正しくありません");
}

/** どの書類からも参照されなくなったファイルを消す（書類の削除のあと） */
export async function deleteFileIfUnused(path: string | null): Promise<void> {
  if (!path) return;
  const [row] = await db()<{ n: number }[]>`
    select count(*)::int n from documents where storage_path = ${path} or preview_path = ${path}`;
  if (row.n > 0) return;
  if (path.startsWith("db:")) {
    await db()`delete from app_private.file_blobs where sha256 = ${path.slice(3)}`;
  } else if (path.startsWith("supabase:") && storageEnv.enabled) {
    await fetch(`${storageEnv.url}/storage/v1/object/${path.slice("supabase:".length)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${storageEnv.serviceRoleKey}` },
    });
  }
}
