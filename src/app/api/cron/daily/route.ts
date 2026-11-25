import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { runWorker } from "@/lib/jobs/worker";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = serverEnv.cronSecret;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!secret || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * 毎日の定期処理（Vercel Cron。vercel.json）
 *   1. 期限切れのデモ組織・セッション・回数の記録・使われなくなったファイルを片付ける
 *   2. 残っている読取の処理（画面を閉じて止まったものなど）を、時間の許す範囲で進める
 */
export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [c] = await db()<{ n: number }[]>`select app_private.demo_cleanup() n`;
  const processed = await runWorker({ budgetMs: 40_000 });
  return Response.json({ ok: true, demoDeleted: c.n, processed });
}
