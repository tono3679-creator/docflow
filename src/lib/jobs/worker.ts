import "server-only";
/**
 * 読取処理のキュー（extraction_jobs）を処理する worker。
 *   - 取り出し：FOR UPDATE SKIP LOCKED。同時に動く複数の worker が同じ処理を取らない
 *   - 同じ書類で動く処理は1つだけ（DB の部分一意 index）。止まった処理は lease_until を過ぎたら取り直す
 *   - 失敗：リトライできる失敗は間隔を空けて再実行（最大 max_attempts 回）。ファイルの破損など直らない失敗はすぐエラー
 *   - 1ファイルの失敗は、ほかのファイルの処理に影響しない（1件ずつ別のトランザクションで保存する）
 *   - 画面の処理を止めない：アップロードの応答のあと（after()）や、状態の確認のリクエストの中で、時間を区切って動かす
 * DB の所有者の接続で動く（ログイン利用者ではない）。読み書きする行は必ず organization_id で絞る。
 */
import { db } from "@/lib/db";
import { aiEnv } from "@/lib/env";
import { analyzePages, readDocument, type UsageEntry } from "@/lib/extraction/pipeline";
import { ImageInspectError } from "@/lib/extraction/image";
import { LlmError } from "@/lib/extraction/llm/anthropic";
import { ocrProvider } from "@/lib/extraction/ocr";
import { OcrError } from "@/lib/extraction/ocr/types";
import { PdfInspectError } from "@/lib/extraction/pdf";
import type { DocumentType } from "@/lib/extraction/types";
import { getFile, putFile } from "@/lib/storage";
import { logUsage, saveExtraction, savePages, toPageText, type StoredPage } from "@/lib/documents/persist";

export type ClaimedJob = {
  id: string;
  organization_id: string;
  document_id: string;
  attempts: number;
  max_attempts: number;
  forced_type: DocumentType | null;
};

class PermanentError extends Error {}

/** 処理を最大 limit 件取り出して「処理中」にする。organizationId を渡すとその組織の処理だけ */
export async function claimJobs(limit: number, organizationId?: string): Promise<ClaimedJob[]> {
  const leaseSeconds = aiEnv().timeoutSeconds + 30;
  const sql = db();
  return sql.begin(async (tx) => {
    // 時間切れで止まった処理のうち、回数を使い切ったものはエラーにする
    const dead = await tx<{ id: string; organization_id: string; document_id: string }[]>`
      update extraction_jobs set status = 'failed', finished_at = now(), last_error = coalesce(last_error, '処理が時間内に終わりませんでした')
       where status = 'running' and lease_until < now() and attempts >= max_attempts
       returning id, organization_id, document_id`;
    for (const d of dead) {
      await tx`update documents set status = 'error', error_message = '処理が時間内に終わりませんでした。読み直してください'
                where id = ${d.document_id} and organization_id = ${d.organization_id} and status in ('queued', 'processing')`;
    }
    const jobs = await tx<ClaimedJob[]>`
      update extraction_jobs j set status = 'running', attempts = j.attempts + 1, locked_at = now(),
             lease_until = now() + make_interval(secs => ${leaseSeconds})
       where j.id in (
         select id from extraction_jobs
          where ((status = 'queued' and run_after <= now()) or (status = 'running' and lease_until < now()))
            and (${organizationId ?? null}::uuid is null or organization_id = ${organizationId ?? null}::uuid)
          order by run_after, created_at
          limit ${limit}
          for update skip locked)
      returning j.id, j.organization_id, j.document_id, j.attempts, j.max_attempts, j.forced_type`;
    for (const j of jobs) {
      await tx`update documents set status = 'processing' where id = ${j.document_id} and organization_id = ${j.organization_id}`;
    }
    return jobs;
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`処理が ${Math.round(ms / 1000)} 秒以内に終わりませんでした`));
      }, ms);
    }),
  ]);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

function isRetryable(e: unknown): boolean {
  if (e instanceof PermanentError || e instanceof PdfInspectError || e instanceof ImageInspectError) return false;
  if (e instanceof OcrError || e instanceof LlmError) return e.retryable;
  return true;
}

/** 1件の処理。成功・失敗とも DB に書いて終わる（例外は外に出さない） */
export async function processJob(job: ClaimedJob): Promise<"succeeded" | "retry" | "failed"> {
  const sql = db();
  const env = aiEnv();
  const started = Date.now();
  const usage: UsageEntry[] = [];
  try {
    const [doc] = await sql<{ id: string; file_type: "pdf" | "png" | "jpeg" | "webp"; storage_path: string; preview_path: string | null; is_demo: boolean; llm_enabled: boolean }[]>`
      select d.id, d.file_type, d.storage_path, d.preview_path, o.is_demo, s.llm_enabled
        from documents d join organizations o on o.id = d.organization_id
        join organization_settings s on s.organization_id = d.organization_id
       where d.id = ${job.document_id} and d.organization_id = ${job.organization_id}`;
    if (!doc) throw new PermanentError("書類が見つかりません");

    const controller = new AbortController();
    const result = await withTimeout((async () => {
      // 書類種別を指定した読み直しで、読み取った文字が保存されていれば OCR をやり直さない
      const stored = job.forced_type
        ? await sql<StoredPage[]>`select page_number, width, height, text_source, ocr_engine, words from document_pages
                                   where document_id = ${doc.id} and organization_id = ${job.organization_id} order by page_number`
        : [];
      let pages;
      let previewPath = doc.preview_path;
      if (stored.length > 0) {
        pages = stored.map(toPageText);
      } else {
        const bytes = await getFile(doc.storage_path);
        const read = await readDocument(new Uint8Array(bytes), doc.file_type);
        usage.push(...read.usage);
        pages = read.pages;
        if (read.preview) previewPath = await putFile(read.preview.png, "image/png");
      }
      // デモ環境の書類は外部の AI に送らない
      const analyzed = await analyzePages(pages, {
        forcedType: job.forced_type,
        signal: controller.signal,
        lastAttempt: job.attempts >= job.max_attempts,
        allowLlm: doc.llm_enabled && !doc.is_demo,
      });
      usage.push(...analyzed.usage);
      return { pages, analyzed, previewPath, reused: stored.length > 0 };
    })(), env.timeoutSeconds * 1000, controller);

    await sql.begin(async (tx) => {
      // 処理の途中で別の worker に取られていないか（時間切れで取り直された）
      const [still] = await tx<{ id: string }[]>`
        select id from extraction_jobs where id = ${job.id} and status = 'running' and attempts = ${job.attempts} for update`;
      if (!still) return;
      if (!result.reused) await savePages(tx, job.organization_id, job.document_id, result.pages);
      if (result.previewPath !== doc.preview_path) {
        await tx`update documents set preview_path = ${result.previewPath} where id = ${doc.id} and organization_id = ${job.organization_id}`;
      }
      const { openIssues } = await saveExtraction(tx, {
        orgId: job.organization_id,
        documentId: job.document_id,
        jobId: job.id,
        pages: result.pages,
        analyzed: result.analyzed,
        forcedType: job.forced_type,
        ocrProvider: result.pages.some((p) => p.source === "ocr") ? ocrProvider().name : null,
        durationMs: Date.now() - started,
      });
      await logUsage(tx, job.organization_id, job.document_id, usage);
      await tx`update extraction_jobs set status = 'succeeded', finished_at = now(), last_error = null, lease_until = null where id = ${job.id}`;
      await tx`insert into audit_logs (organization_id, action, entity, entity_id, detail)
               values (${job.organization_id}, 'document.processed', 'document', ${job.document_id},
                       ${tx.json({ method: result.analyzed.method, type: result.analyzed.output.documentType, open_issues: openIssues, ms: Date.now() - started, notes: result.analyzed.output.notes })})`;
    });
    return "succeeded";
  } catch (e) {
    const message = errorText(e);
    const retry = isRetryable(e) && job.attempts < job.max_attempts;
    try {
      await sql.begin(async (tx) => {
        await logUsage(tx, job.organization_id, job.document_id, usage.length ? usage : [{ kind: "ocr", provider: "pipeline", model: null, pages: 0, inputTokens: null, outputTokens: null, durationMs: Date.now() - started, success: false, error: message }]);
        if (retry) {
          // 10秒・40秒・90秒…と間隔を空ける
          await tx`update extraction_jobs set status = 'queued', last_error = ${message}, lease_until = null,
                     run_after = now() + make_interval(secs => ${10 * job.attempts * job.attempts}) where id = ${job.id}`;
          await tx`update documents set status = 'queued', error_message = ${`再試行します（${job.attempts}/${job.max_attempts}）：${message}`.slice(0, 500)}
                    where id = ${job.document_id} and organization_id = ${job.organization_id}`;
        } else {
          await tx`update extraction_jobs set status = 'failed', last_error = ${message}, finished_at = now(), lease_until = null where id = ${job.id}`;
          await tx`update documents set status = 'error', error_message = ${message}
                    where id = ${job.document_id} and organization_id = ${job.organization_id}`;
          await tx`insert into audit_logs (organization_id, action, entity, entity_id, detail)
                   values (${job.organization_id}, 'document.failed', 'document', ${job.document_id}, ${tx.json({ error: message, attempts: job.attempts })})`;
        }
      });
    } catch (inner) {
      console.error("[worker] 失敗の記録に失敗しました", inner);
    }
    console.error(`[worker] job ${job.id} ${retry ? "retry" : "failed"}: ${message}`);
    return retry ? "retry" : "failed";
  }
}

/**
 * 決めた時間の中で、キューの処理を進める。同時に動かす数は EXTRACTION_CONCURRENCY。
 * 戻り値：処理した件数（成功・失敗とも）
 */
export async function runWorker(options: { budgetMs: number; organizationId?: string; maxJobs?: number }): Promise<number> {
  const deadline = Date.now() + options.budgetMs;
  const concurrency = aiEnv().concurrency;
  const perJob = aiEnv().timeoutSeconds * 1000;
  let done = 0;
  while (Date.now() + Math.min(perJob, 15_000) < deadline && (options.maxJobs === undefined || done < options.maxJobs)) {
    const want = Math.min(concurrency, options.maxJobs === undefined ? concurrency : options.maxJobs - done);
    const jobs = await claimJobs(want, options.organizationId);
    if (jobs.length === 0) break;
    await Promise.all(jobs.map((j) => processJob(j)));
    done += jobs.length;
  }
  return done;
}
