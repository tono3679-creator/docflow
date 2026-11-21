import { asCurrentUser, getCurrentUser } from "@/lib/auth";
import { kickWorker } from "@/lib/jobs/kick";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 処理の状態（一括処理の進み具合・確認画面の自動更新）。?ids=a,b,c または ?batch=<id>
 * 未処理の書類があれば、応答のあとに worker を動かして処理を進める（処理を進めるきっかけを兼ねる）。
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "ログインしてください" }, { status: 401 });
  const sp = new URL(request.url).searchParams;
  const ids = (sp.get("ids") ?? "").split(",").filter((s) => UUID.test(s)).slice(0, 200);
  const batch = UUID.test(sp.get("batch") ?? "") ? sp.get("batch") : null;
  if (ids.length === 0 && !batch) return Response.json({ documents: [] });
  const documents = await asCurrentUser((tx) => tx<{ id: string; filename: string; status: string; document_type: string | null; open_issue_count: number; error_message: string | null; version: number }[]>`
    select id, filename, status, document_type, open_issue_count, error_message, version from documents
     where (id = any(${ids}::uuid[]) or (${batch}::uuid is not null and batch_id = ${batch}::uuid))
     order by uploaded_at, id limit 200`);
  if (documents.some((d) => d.status === "queued" || d.status === "processing")) await kickWorker(user.organizationId);
  return Response.json({ documents }, { headers: { "cache-control": "no-store" } });
}
