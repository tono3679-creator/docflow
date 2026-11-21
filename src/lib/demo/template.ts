import "server-only";
/**
 * デモの元データ（is_template の組織「株式会社山田商事」）を作る。
 *   - 書類：demo/documents の架空の書類（ファイル本体は DB に保存）
 *   - 読取結果：demo/results（scripts/demo/process-documents.ts で実際の読取処理にかけた結果）を「事前に処理した結果」として保存
 *     （is_sample・is_precomputed。画面には「事前に処理した結果」と表示する。AI が今処理したようには見せない）
 *   - 検証：保存のときに src/lib/validation で計算する（実際の画面の処理と同じ）
 *   - 一部の書類は、利用者が確認して確定した状態にする（DB の関数を管理者の権限で実行する）
 * 訪問者ごとのデモ・見本の組織は、ここから clone_documents で複製する。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";
import { runAsUser } from "@/lib/db/rls";
import { normalizeImage } from "@/lib/extraction/image";
import { detectFileType, MIME_BY_TYPE } from "@/lib/extraction/file-type";
import type { AnalyzeResult, UsageEntry } from "@/lib/extraction/pipeline";
import type { ExtractionOutput, PageText } from "@/lib/extraction/types";
import { logUsage, saveExtraction, savePages } from "@/lib/documents/persist";
import { syncValidationAsUser } from "@/lib/documents/validation";
import { sha256 } from "@/lib/storage";

export const DEMO_COMPANY = "株式会社山田商事";

export const DEMO_PEOPLE = [
  { role: "admin" as const, name: "山田 太郎", email: "admin@docflow.example" },
  { role: "staff" as const, name: "佐藤 健", email: "staff@docflow.example" },
  { role: "viewer" as const, name: "鈴木 花子", email: "viewer@docflow.example" },
];

type Truth = { id: string; filename: string; pattern: string; document_type: string; confirm_days_ago: number | null; copy_of: string | null };
type Result = {
  id: string;
  filename: string;
  processed_at: string;
  duration_ms: number;
  method: string;
  ocr_engine: string | null;
  llm: AnalyzeResult["llm"];
  pages: PageText[];
  preview: { width: number; height: number } | null;
  output: ExtractionOutput;
  usage: UsageEntry[];
};

const ROOT = process.cwd();
const HOUR = 3600_000;

async function putBlob(sql: Sql, bytes: Uint8Array, mime: string): Promise<string> {
  const hash = sha256(bytes);
  await sql`insert into app_private.file_blobs (sha256, content, byte_size, mime_type)
            values (${hash}, ${Buffer.from(bytes)}, ${bytes.byteLength}, ${mime}) on conflict (sha256) do nothing`;
  return `db:${hash}`;
}

/** 確定済みにする書類で、確認事項を片付ける（確認済みにする・理由を付けて承認する）。片付かなければ false */
async function confirmAsReviewer(sql: Sql, orgId: string, userId: string, documentId: string): Promise<boolean> {
  return runAsUser(sql, userId, async (tx) => {
    await syncValidationAsUser(tx, orgId, documentId);
    const issues = await tx<{ id: string; field_id: string | null; issue_type: string; severity: string }[]>`
      select id, field_id, issue_type, severity from validation_issues where document_id = ${documentId} and status = 'open'`;
    if (issues.some((i) => ["missing_required", "duplicate", "read_failed", "type_unknown"].includes(i.issue_type))) return false;
    const [doc] = await tx<{ version: number }[]>`select version from documents where id = ${documentId}`;
    const changes = [
      ...[...new Set(issues.filter((i) => i.field_id && i.severity === "warning").map((i) => i.field_id))].map((id) => ({ op: "set", field_id: id, review_status: "confirmed" })),
      ...issues.filter((i) => i.severity === "error").map((i) => ({ op: "accept_issue", issue_id: i.id, reason: "原本と照合済み（デモ）" })),
    ];
    let version = doc.version;
    if (changes.length) {
      const [r] = await tx<{ v: number }[]>`select apply_review_changes(${documentId}, ${version}, ${tx.json(changes as never)}) v`;
      version = r.v;
      await syncValidationAsUser(tx, orgId, documentId);
    }
    const [left] = await tx<{ n: number }[]>`select count(*)::int n from validation_issues where document_id = ${documentId} and status = 'open'`;
    if (left.n > 0) return false;
    await tx`select confirm_document(${documentId}, ${version})`;
    return true;
  }, orgId);
}

/** 元データの組織を作り直す。戻り値はその組織の ID */
export async function buildTemplate(sql: Sql, opts: { now?: Date; log?: (s: string) => void } = {}): Promise<string> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? new Date();
  const truth: Truth[] = JSON.parse(await readFile(path.join(ROOT, "demo/ground-truth.json"), "utf8"));
  const results = new Map<string, Result>();
  for (const t of truth) results.set(t.id, JSON.parse(await readFile(path.join(ROOT, "demo/results", `${t.id}.json`), "utf8")));

  // 前の元データを消す（訪問者のデモは別の組織に複製済みなので影響しない。ファイル本体は共有のまま残る）
  const orgId = await sql.begin(async (tx) => {
    const old = await tx<{ user_id: string }[]>`
      select m.user_id from organization_members m join organizations o on o.id = m.organization_id where o.is_template`;
    await tx`delete from organizations where is_template`;
    if (old.length) await tx`delete from app_auth.users where id = any(${old.map((o) => o.user_id)}::uuid[]) and is_anonymous`;
    const [org] = await tx<{ id: string }[]>`
      insert into organizations (name, is_template, created_at) values (${DEMO_COMPANY}, true, ${now}) returning id`;
    await tx`insert into organization_settings (organization_id, staff_confirm_limit) values (${org.id}, 1000000)`;
    for (const p of DEMO_PEOPLE) {
      const [u] = await tx<{ id: string }[]>`insert into app_auth.users (is_anonymous) values (true) returning id`;
      await tx`insert into profiles (id, display_name) values (${u.id}, ${p.name})`;
      await tx`insert into organization_members (organization_id, user_id, role, created_at) values (${org.id}, ${u.id}, ${p.role}, ${now})`;
    }
    return org.id;
  });
  const people = await sql<{ user_id: string; role: string }[]>`select user_id, role from organization_members where organization_id = ${orgId}`;
  const userOf = (role: string) => people.find((p) => p.role === role)!.user_id;

  // 古い書類から順に登録する（重複の判定は「先に登録された書類」と比べるため）
  const order = [...truth].sort((a, b) => (b.confirm_days_ago ?? -1) - (a.confirm_days_ago ?? -1) || truth.indexOf(a) - truth.indexOf(b));
  const pending = order.filter((t) => t.confirm_days_ago === null);
  let count = 0;
  for (const t of order) {
    const r = results.get(t.id)!;
    const bytes = new Uint8Array(await readFile(path.join(ROOT, "demo/documents", t.filename)));
    const fileType = detectFileType(bytes);
    if (!fileType) throw new Error(`形式が不明：${t.filename}`);
    // 登録日時：確定済みの書類は確定した日の前日、確認待ちの書類はこの2日の間
    const uploadedAt = t.confirm_days_ago !== null
      ? new Date(now.getTime() - (t.confirm_days_ago + 1) * 24 * HOUR - 2 * HOUR)
      : new Date(now.getTime() - (2 + (pending.length - pending.indexOf(t)) * 1.2) * HOUR);
    const processedAt = new Date(uploadedAt.getTime() + Math.max(r.duration_ms, 400) + 1500);
    const storagePath = await putBlob(sql, bytes, MIME_BY_TYPE[fileType]);
    let previewPath: string | null = null;
    if (fileType !== "pdf") {
      const img = await normalizeImage(bytes);
      if (r.preview && (img.width !== r.preview.width || img.height !== r.preview.height)) {
        throw new Error(`${t.id} の表示用画像の大きさが読取時と違います（座標がずれるため中止）`);
      }
      previewPath = await putBlob(sql, img.png, "image/png");
    }
    await sql.begin(async (tx) => {
      const [doc] = await tx<{ id: string }[]>`
        insert into documents (organization_id, uploaded_by, filename, file_type, mime_type, file_size, storage_path, preview_path, file_hash,
                               status, page_count, is_sample, uploaded_at, created_at)
        values (${orgId}, ${userOf("staff")}, ${t.filename}, ${fileType}, ${MIME_BY_TYPE[fileType]}, ${bytes.byteLength}, ${storagePath},
                ${previewPath}, ${sha256(bytes)}, 'processing', ${Math.max(1, r.pages.length)}, true, ${uploadedAt}, ${uploadedAt})
        returning id`;
      const [job] = await tx<{ id: string }[]>`
        insert into extraction_jobs (organization_id, document_id, status, attempts, requested_by, run_after, created_at, finished_at)
        values (${orgId}, ${doc.id}, 'succeeded', 1, ${userOf("staff")}, ${uploadedAt}, ${uploadedAt}, ${processedAt}) returning id`;
      await savePages(tx, orgId, doc.id, r.pages);
      await saveExtraction(tx, {
        orgId, documentId: doc.id, jobId: job.id, pages: r.pages,
        analyzed: { output: r.output, method: r.method, llm: r.llm, usage: r.usage },
        forcedType: null, ocrProvider: r.ocr_engine ? "tesseract" : null, durationMs: r.duration_ms,
        isPrecomputed: true, processedAt,
      });
      await logUsage(tx, orgId, doc.id, r.usage, processedAt);
      await tx`insert into audit_logs (organization_id, actor_id, action, entity, entity_id, detail, created_at)
               values (${orgId}, ${userOf("staff")}, 'document.upload', 'document', ${doc.id},
                       ${tx.json({ filename: t.filename, size: bytes.byteLength, pages: r.pages.length })}, ${uploadedAt}),
                      (${orgId}, null, 'document.processed', 'document', ${doc.id},
                       ${tx.json({ method: r.method, type: r.output.documentType, precomputed: true, ms: r.duration_ms })}, ${processedAt})`;
      // 一覧・時刻の写しを、元の書類の登録日時に合わせる
      await tx`update documents set updated_at = ${processedAt} where id = ${doc.id}`;
      await tx`update document_fields set created_at = ${processedAt}, updated_at = ${processedAt} where document_id = ${doc.id}`;
      await tx`update validation_issues set created_at = ${processedAt} where document_id = ${doc.id}`;
      await tx`update extraction_results set created_at = ${processedAt} where document_id = ${doc.id}`;
    });

    if (t.confirm_days_ago !== null) {
      const [doc] = await sql<{ id: string }[]>`select id from documents where organization_id = ${orgId} and filename = ${t.filename} and file_hash = ${sha256(bytes)}`;
      const reviewer = t.confirm_days_ago % 2 === 0 ? userOf("staff") : userOf("admin");
      const ok = await confirmAsReviewer(sql, orgId, reviewer, doc.id);
      if (!ok) {
        log(`  ${t.id}：確認事項が残るため確定しませんでした`);
      } else {
        const confirmedAt = new Date(uploadedAt.getTime() + 26 * HOUR);
        await sql.begin(async (tx) => {
          await tx`update documents set confirmed_at = ${confirmedAt}, updated_at = ${confirmedAt} where id = ${doc.id}`;
          await tx`update document_fields set reviewed_at = case when reviewed_at is null then null else ${confirmedAt}::timestamptz end where document_id = ${doc.id}`;
          await tx`update validation_issues set resolved_at = case when resolved_at is null then null else ${confirmedAt}::timestamptz end where document_id = ${doc.id}`;
          await tx`update review_actions set created_at = ${confirmedAt} where document_id = ${doc.id}`;
          await tx`update document_confirmations set confirmed_at = ${confirmedAt} where document_id = ${doc.id}`;
          await tx`update audit_logs set created_at = ${confirmedAt} where entity_id = ${doc.id} and action = 'document.confirm'`;
        });
      }
    }
    count++;
  }
  // 出力の記録（確定済みの請求書を出力した、という過去の操作）
  const confirmed = await sql<{ id: string }[]>`select id from documents where organization_id = ${orgId} and status = 'confirmed' and document_type = 'invoice'`;
  if (confirmed.length) {
    const at = new Date(now.getTime() - 3 * 24 * HOUR);
    await sql`insert into export_jobs (organization_id, requested_by, format, target, document_ids, row_count, created_at)
              values (${orgId}, ${userOf("admin")}, 'xlsx', 'all', ${confirmed.map((c) => c.id)}::uuid[], ${confirmed.length}, ${at})`;
  }
  const [stats] = await sql<{ total: number; confirmed: number; review: number }[]>`
    select count(*)::int total, count(*) filter (where status = 'confirmed')::int confirmed,
           count(*) filter (where status in ('needs_review', 'ready'))::int review
      from documents where organization_id = ${orgId}`;
  log(`デモの元データを作り直しました（書類 ${stats.total}・確定済み ${stats.confirmed}・確認待ち ${stats.review}）`);
  if (count !== truth.length) throw new Error("書類の登録数が一致しません");
  return orgId;
}
