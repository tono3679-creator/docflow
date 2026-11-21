import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/domain/labels";
import { acceptFile, demoUploadAllowed, type UploadOutcome } from "@/lib/documents/upload";
import { kickWorker } from "@/lib/jobs/kick";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * アップロード（multipart/form-data。files に1つ以上のファイル、batch に一括処理の ID）。
 * ファイルごとに受け付けたか・断った理由を返す（1つが断られても、ほかは受け付ける）。
 * 読取は応答のあとに始める（画面を待たせない）。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "ログインしてください" }, { status: 401 });
  if (!can.upload(user.role)) return Response.json({ error: "アップロードする権限がありません" }, { status: 403 });
  if (!(await demoUploadAllowed(user))) {
    return Response.json({ error: "デモ環境では1時間にアップロードできる数に上限があります。しばらくしてからお試しください" }, { status: 429 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "ファイルを受け取れませんでした（大きすぎる可能性があります）" }, { status: 400 });
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return Response.json({ error: "ファイルを選んでください" }, { status: 400 });
  if (files.length > MAX_FILES) return Response.json({ error: `一度に送れるのは ${MAX_FILES} ファイルまでです` }, { status: 400 });
  const batchRaw = String(form.get("batch") ?? "");
  const batchId = UUID.test(batchRaw) ? batchRaw : null;

  const results: UploadOutcome[] = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      results.push(await acceptFile(user, { name: file.name, type: file.type, bytes }, batchId));
    } catch (e) {
      console.error(e);
      results.push({ filename: file.name.slice(0, 200), ok: false, reason: "受け付けられませんでした" });
    }
  }
  if (results.some((r) => r.ok)) await kickWorker(user.organizationId);
  return Response.json({ results });
}
