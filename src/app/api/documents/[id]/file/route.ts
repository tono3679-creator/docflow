import { asCurrentUser, getCurrentUser } from "@/lib/auth";
import { getFile } from "@/lib/storage";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 書類のファイル（原本）。?preview=1 で画像の表示用 PNG（座標の基準）。
 * 利用者が RLS 付きでその書類を読めたときだけ返す（別の組織の書類は「見つかりません」）。
 * 表示はアプリの中だけ：ダウンロードではなく inline、スクリプトを動かさない（CSP sandbox）、キャッシュは本人の端末だけ。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not Found", { status: 404 });
  const user = await getCurrentUser();
  if (!user) return new Response("ログインしてください", { status: 401 });
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  const download = new URL(request.url).searchParams.get("download") === "1";
  const [doc] = await asCurrentUser((tx) => tx<{ storage_path: string; preview_path: string | null; mime_type: string; filename: string }[]>`
    select storage_path, preview_path, mime_type, filename from documents where id = ${id}`);
  if (!doc) return new Response("Not Found", { status: 404 });
  const path = preview ? doc.preview_path : doc.storage_path;
  if (!path) return new Response("Not Found", { status: 404 });
  const body = await getFile(path);
  const type = preview ? "image/png" : doc.mime_type;
  const name = encodeURIComponent(preview ? doc.filename.replace(/\.[^.]+$/, "") + "_preview.png" : doc.filename);
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": type,
      "content-length": String(body.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
