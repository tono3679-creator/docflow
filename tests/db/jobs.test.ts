/**
 * 読取処理のキュー：同じ処理を2つの worker が取らない・同じ書類の処理は1つだけ・止まった処理の取り直し・回数の上限。
 * ローカルの PostgreSQL が必要（npm run test:db）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, expectPgError, prepareTestDb, type World } from "./helpers";
import { claimJobs } from "@/lib/jobs/worker";
import { db } from "@/lib/db";

let w: World;

beforeAll(async () => {
  w = await prepareTestDb();
});

afterAll(async () => {
  await w?.sql.end();
  await db().end();
});

async function readyDocs(n: number) {
  const rows = await w.sql<{ id: string }[]>`
    select id from documents where organization_id = ${w.other.id} and status in ('ready', 'needs_review') order by uploaded_at limit ${n}`;
  expect(rows.length).toBe(n);
  return rows.map((r) => r.id);
}

describe("読取処理のキュー", () => {
  it("読み直しの依頼を重ねても、同じ書類の処理は1つだけ", async () => {
    const [id] = await readyDocs(1);
    const staff = w.other.users.staff;
    const first = (await as(w, staff, (tx) => tx<{ id: string }[]>`select request_extraction(${id}, null) id`))[0].id;
    const second = (await as(w, staff, (tx) => tx<{ id: string }[]>`select request_extraction(${id}, 'receipt') id`))[0].id;
    expect(second).toBe(first);
    const [{ n }] = await w.sql<{ n: number }[]>`select count(*)::int n from extraction_jobs where document_id = ${id} and status in ('queued', 'running')`;
    expect(n).toBe(1);
    // DB の一意の制約でも防ぐ
    await expectPgError(w.sql`insert into extraction_jobs (organization_id, document_id) values (${w.other.id}, ${id})`, "23505");
  });

  it("同時に動く worker が同じ処理を取らない", async () => {
    // 前のテストの1件と合わせて7件を待ちにする
    const ids = await readyDocs(6);
    for (const id of ids) await as(w, w.other.users.staff, (tx) => tx`select request_extraction(${id}, null)`);
    const [{ queued }] = await w.sql<{ queued: number }[]>`select count(*)::int queued from extraction_jobs where organization_id = ${w.other.id} and status = 'queued'`;
    expect(queued).toBe(7);
    const batches = await Promise.all([claimJobs(3, w.other.id), claimJobs(3, w.other.id), claimJobs(3, w.other.id)]);
    const claimed = batches.flat().map((j) => j.id);
    expect(claimed.length).toBe(7);
    expect(new Set(claimed).size).toBe(7);
    const docs = await w.sql<{ status: string }[]>`select status from documents where id = any(${ids}::uuid[])`;
    expect(docs.every((d) => d.status === "processing")).toBe(true);
    // ほかの組織の処理は取らない
    expect(batches.flat().every((j) => j.organization_id === w.other.id)).toBe(true);
  });

  it("止まった処理は期限を過ぎたら取り直し、回数を使い切ったらエラーにする", async () => {
    const [retry, dead] = await w.sql<{ id: string; document_id: string }[]>`
      select id, document_id from extraction_jobs where organization_id = ${w.other.id} and status = 'running' order by created_at limit 2`;
    await w.sql`update extraction_jobs set lease_until = now() - interval '1 second', attempts = 1 where id = ${retry.id}`;
    await w.sql`update extraction_jobs set lease_until = now() - interval '1 second', attempts = max_attempts where id = ${dead.id}`;
    const again = await claimJobs(10, w.other.id);
    expect(again.map((j) => j.id)).toEqual([retry.id]);
    expect(again[0].attempts).toBe(2);
    const [job] = await w.sql<{ status: string }[]>`select status from extraction_jobs where id = ${dead.id}`;
    expect(job.status).toBe("failed");
    const [doc] = await w.sql<{ status: string; error_message: string }[]>`select status, error_message from documents where id = ${dead.document_id}`;
    expect(doc.status).toBe("error");
    expect(doc.error_message).toMatch(/読み直して/);
  });

  it("確定済み・除外した書類は読み直せない", async () => {
    const [doc] = await w.sql<{ id: string }[]>`select id from documents where organization_id = ${w.other.id} and status = 'confirmed' limit 1`;
    await expectPgError(as(w, w.other.users.admin, (tx) => tx`select request_extraction(${doc.id}, null)`), "55000");
  });
});
