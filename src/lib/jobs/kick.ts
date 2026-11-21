import "server-only";
/**
 * worker を動かすきっかけ。応答を返したあと（after()）に、時間を区切って組織のキューを進める。
 * 同時に動く処理が EXTRACTION_CONCURRENCY に達していれば新しく始めない（状態の確認が何度来ても増えすぎない）。
 */
import { after } from "next/server";
import { db } from "@/lib/db";
import { aiEnv } from "@/lib/env";
import { runWorker } from "./worker";

/** 1回のきっかけで処理を進める時間（関数の実行時間の上限 60 秒に収める） */
export const WORKER_BUDGET_MS = 45_000;

export async function kickWorker(organizationId: string): Promise<{ ready: number; running: number }> {
  const [row] = await db()<{ ready: number; running: number }[]>`
    select count(*) filter (where status = 'queued' and run_after <= now())::int ready,
           count(*) filter (where status = 'running' and lease_until > now())::int running
      from extraction_jobs where organization_id = ${organizationId}`;
  if (row.ready > 0 && row.running < aiEnv().concurrency) {
    after(async () => {
      try {
        await runWorker({ budgetMs: WORKER_BUDGET_MS, organizationId });
      } catch (e) {
        console.error("[worker]", e);
      }
    });
  }
  return row;
}
