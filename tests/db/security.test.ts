/**
 * DB の守り：組織ごとの分離（RLS）・役割ごとの権限・確定の条件・管理者の保護・デモの制限。
 * 画面やサーバーの確認とは別に、DB だけでも守られていることを確かめる（アプリの不具合があっても漏れない・壊れない）。
 * ローカルの PostgreSQL が必要（npm run test:db）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, expectPgError, prepareTestDb, type World } from "./helpers";

let w: World;

beforeAll(async () => {
  w = await prepareTestDb();
});

afterAll(async () => {
  await w?.sql.end();
});

/** 見本の組織の書類を1件（条件に合うもの） */
async function pickDoc(where: "needs_review_with_issue" | "ready" | "confirmed", orgId = w.showcase.id) {
  const rows =
    where === "needs_review_with_issue"
      ? await w.sql<{ id: string; version: number }[]>`
          select d.id, d.version from documents d where d.organization_id = ${orgId} and d.status = 'needs_review' and d.open_issue_count > 0
             and not exists (select 1 from duplicate_candidates c where c.document_id = d.id and c.status = 'pending')
           order by d.uploaded_at limit 1`
      : await w.sql<{ id: string; version: number }[]>`
          select d.id, d.version from documents d where d.organization_id = ${orgId} and d.status = ${where}
             and not exists (select 1 from duplicate_candidates c where c.document_id = d.id and c.status = 'pending')
           order by d.uploaded_at limit 1`;
  expect(rows[0], `条件に合う書類（${where}）がありません`).toBeDefined();
  return rows[0];
}

const versionOf = async (id: string) => (await w.sql<{ version: number }[]>`select version from documents where id = ${id}`)[0].version;

describe("組織ごとの分離（RLS）", () => {
  it("自分の組織の書類だけが見える", async () => {
    const [{ total }] = await w.sql<{ total: number }[]>`select count(*)::int total from documents where organization_id = ${w.showcase.id}`;
    expect(total).toBeGreaterThan(30);
    const seen = await as(w, w.other.users.admin, (tx) => tx<{ organization_id: string }[]>`select distinct organization_id from documents`);
    expect(seen.map((r) => r.organization_id)).toEqual([w.other.id]);
  });

  it("ほかの組織の書類は ID を指定しても読めない・操作できない", async () => {
    const doc = await pickDoc("ready");
    for (const table of ["documents", "document_fields", "validation_issues", "review_actions", "document_pages", "extraction_results"] as const) {
      const rows = await as(w, w.other.users.admin, (tx) =>
        table === "documents" ? tx`select 1 from documents where id = ${doc.id}` : tx`select 1 from ${tx(table)} where document_id = ${doc.id}`,
      );
      expect(rows.length, table).toBe(0);
    }
    await expectPgError(as(w, w.other.users.admin, (tx) => tx`select apply_review_changes(${doc.id}, ${doc.version}, '[]'::jsonb)`), "P0002");
    await expectPgError(as(w, w.other.users.admin, (tx) => tx`select confirm_document(${doc.id}, ${doc.version})`), "P0002");
    await expectPgError(as(w, w.other.users.admin, (tx) => tx`select * from delete_document(${doc.id})`), "P0002");
    expect(await versionOf(doc.id)).toBe(doc.version);
  });

  it("所属していない組織を指定すると何も見えない（組織の切り替えで他社に入れない）", async () => {
    const r = await as(w, w.showcase.users.admin, async (tx) => {
      const [org] = await tx<{ id: string | null }[]>`select current_org_id() id`;
      const [docs] = await tx<{ n: number }[]>`select count(*)::int n from documents`;
      return { org: org.id, docs: docs.n };
    }, w.other.id);
    expect(r).toEqual({ org: null, docs: 0 });
  });

  it("操作の記録・AI の利用記録・メンバー・設定もほかの組織のものは見えない", async () => {
    const r = await as(w, w.other.users.admin, async (tx) => ({
      audit: (await tx<{ n: number }[]>`select count(*)::int n from audit_logs where organization_id <> ${w.other.id}`)[0].n,
      members: (await tx<{ n: number }[]>`select count(*)::int n from organization_members where organization_id <> ${w.other.id}`)[0].n,
      settings: (await tx<{ n: number }[]>`select count(*)::int n from organization_settings where organization_id <> ${w.other.id}`)[0].n,
      profiles: (await tx<{ n: number }[]>`select count(*)::int n from profiles where id = ${w.showcase.users.admin}`)[0].n,
    }));
    expect(r).toEqual({ audit: 0, members: 0, settings: 0, profiles: 0 });
  });

  it("書類の表には直接書き込めない（書き込みは確かめる DB 関数だけ）", async () => {
    const doc = await pickDoc("needs_review_with_issue");
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`update documents set status = 'confirmed' where id = ${doc.id}`), "42501");
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`delete from validation_issues where document_id = ${doc.id}`), "42501");
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`update document_fields set review_status = 'confirmed' where document_id = ${doc.id}`), "42501");
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`update organization_settings set llm_enabled = true`), "42501");
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`update organization_members set role = 'admin'`), "42501");
  });

  it("ファイル本体・ログインの情報は利用者の権限では読めない", async () => {
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`select count(*) from app_private.file_blobs`), "42501");
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`select count(*) from app_auth.users`), "42501");
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`select count(*) from app_auth.sessions`), "42501");
  });

  it("ログインしていない（anon）と何も読めない", async () => {
    const err = await w.sql
      .begin(async (tx) => {
        await tx`set local role anon`;
        return tx`select count(*) from documents`;
      })
      .catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe("42501");
  });
});

describe("役割ごとの権限", () => {
  it("閲覧者は修正・確定・アップロード・読み直し・出力の記録ができない", async () => {
    const doc = await pickDoc("ready");
    const viewer = w.showcase.users.viewer;
    await expectPgError(as(w, viewer, (tx) => tx`select apply_review_changes(${doc.id}, ${doc.version}, '[]'::jsonb)`), "42501");
    await expectPgError(as(w, viewer, (tx) => tx`select confirm_document(${doc.id}, ${doc.version})`), "42501");
    await expectPgError(as(w, viewer, (tx) => tx`select request_extraction(${doc.id}, null)`), "42501");
    await expectPgError(as(w, viewer, (tx) => tx`select register_document('a.pdf', 'pdf', 'application/pdf', 100, 'db:x', null, 'x', 1, null)`), "42501");
    await expectPgError(as(w, viewer, (tx) => tx`select record_export('csv', 'documents', array[${doc.id}]::uuid[], 1)`), "42501");
    // 読むことはできる
    const rows = await as(w, viewer, (tx) => tx`select id from documents where id = ${doc.id}`);
    expect(rows.length).toBe(1);
  });

  it("担当者は設定・メンバーの変更・メンバーの追加・削除ができない", async () => {
    const staff = w.showcase.users.staff;
    await expectPgError(as(w, staff, (tx) => tx`select update_org_settings(10, 10, 0.8, null, false)`), "42501");
    await expectPgError(as(w, staff, (tx) => tx`select update_member(${w.showcase.users.viewer}, 'admin', true)`), "42501");
    await expectPgError(as(w, staff, (tx) => tx`select admin_add_member('x@example.com', 'x', 'admin', 'scrypt$x')`), "42501");
    const doc = await pickDoc("ready");
    await expectPgError(as(w, staff, (tx) => tx`select * from delete_document(${doc.id})`), "42501");
  });

  it("担当者は設定の金額を超える書類を確定できない（管理者は確定できる）", async () => {
    const doc = await pickDoc("ready");
    const [{ total }] = await w.sql<{ total: number | null }[]>`select total_amount total from documents where id = ${doc.id}`;
    expect(total).not.toBeNull();
    const [{ before }] = await w.sql<{ before: number | null }[]>`select staff_confirm_limit before from organization_settings where organization_id = ${w.showcase.id}`;
    await w.sql`update organization_settings set staff_confirm_limit = ${total! - 1} where organization_id = ${w.showcase.id}`;
    try {
      await expectPgError(as(w, w.showcase.users.staff, (tx) => tx`select confirm_document(${doc.id}, ${doc.version})`), "42501", /管理者が確定/);
      await as(w, w.showcase.users.admin, (tx) => tx`select confirm_document(${doc.id}, ${doc.version})`);
      const [d] = await w.sql<{ status: string; confirmed_by: string }[]>`select status, confirmed_by from documents where id = ${doc.id}`;
      expect(d).toEqual({ status: "confirmed", confirmed_by: w.showcase.users.admin });
    } finally {
      await w.sql`update organization_settings set staff_confirm_limit = ${before} where organization_id = ${w.showcase.id}`;
    }
  });

  it("利用停止にしたメンバーは何も見えず、操作もできない", async () => {
    const { admin, viewer } = w.showcase.users;
    await as(w, admin, (tx) => tx`select update_member(${viewer}, 'viewer', false)`);
    try {
      const rows = await as(w, viewer, (tx) => tx`select id from documents limit 1`);
      expect(rows.length).toBe(0);
    } finally {
      await as(w, admin, (tx) => tx`select update_member(${viewer}, 'viewer', true)`);
    }
    expect((await as(w, viewer, (tx) => tx`select id from documents limit 1`)).length).toBe(1);
  });
});

describe("修正と確定の条件", () => {
  it("値を直しただけでは確認済みにならない（確認済みの項目を直すと未確認に戻る）", async () => {
    const doc = await pickDoc("needs_review_with_issue");
    const [field] = await w.sql<{ id: string; value: string }[]>`
      select id, value from document_fields where document_id = ${doc.id} and value is not null and line_index is null order by field_key limit 1`;
    const staff = w.showcase.users.staff;
    let v = doc.version;
    v = (await as(w, staff, (tx) => tx<{ v: number }[]>`select apply_review_changes(${doc.id}, ${v}, ${w.sql.json([{ op: "set", field_id: field.id, review_status: "confirmed" }])}) v`))[0].v;
    let [f] = await w.sql<{ review_status: string; source: string }[]>`select review_status, source from document_fields where id = ${field.id}`;
    expect(f.review_status).toBe("confirmed");
    v = (await as(w, staff, (tx) => tx<{ v: number }[]>`select apply_review_changes(${doc.id}, ${v}, ${w.sql.json([{ op: "set", field_id: field.id, value: `${field.value}1` }])}) v`))[0].v;
    [f] = await w.sql<{ review_status: string; source: string }[]>`select review_status, source from document_fields where id = ${field.id}`;
    expect(f).toEqual({ review_status: "unreviewed", source: "user" });
    // 元に戻す（履歴は残る）
    await as(w, staff, (tx) => tx`select apply_review_changes(${doc.id}, ${v}, ${w.sql.json([{ op: "set", field_id: field.id, value: field.value }])})`);
    const actions = await w.sql<{ action: string }[]>`select action from review_actions where field_id = ${field.id} order by created_at, id`;
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["confirm_field", "edit", "unconfirm_field"]));
  });

  it("古い版の画面からの保存・確定は断る（同時に操作したときの上書きを防ぐ）", async () => {
    const doc = await pickDoc("needs_review_with_issue");
    const v = await versionOf(doc.id);
    await as(w, w.showcase.users.staff, (tx) => tx`select apply_review_changes(${doc.id}, ${v}, '[]'::jsonb)`);
    await expectPgError(as(w, w.showcase.users.staff, (tx) => tx`select apply_review_changes(${doc.id}, ${v}, '[]'::jsonb)`), "40001");
    await expectPgError(as(w, w.showcase.users.staff, (tx) => tx`select confirm_document(${doc.id}, ${v})`), "40001");
  });

  it("未確認の確認事項が残っている書類は確定できない", async () => {
    const doc = await pickDoc("needs_review_with_issue");
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`select confirm_document(${doc.id}, ${doc.version})`), "55000", /未確認の項目/);
  });

  it("重複の疑いを判断していない書類は確定できない", async () => {
    const [doc] = await w.sql<{ id: string; version: number }[]>`
      select d.id, d.version from documents d join duplicate_candidates c on c.document_id = d.id and c.status = 'pending'
       where d.organization_id = ${w.showcase.id} limit 1`;
    expect(doc).toBeDefined();
    await w.sql`update validation_issues set status = 'accepted', accept_reason = 'テスト' where document_id = ${doc.id} and status = 'open'`;
    await w.sql`update documents set open_issue_count = 0 where id = ${doc.id}`;
    await expectPgError(as(w, w.showcase.users.admin, (tx) => tx`select confirm_document(${doc.id}, ${doc.version})`), "55000", /重複/);
  });

  it("承認には理由が要る。確定した書類は修正できず、理由を付けて再確認に戻す", async () => {
    const doc = await pickDoc("needs_review_with_issue");
    const [issue] = await w.sql<{ id: string }[]>`select id from validation_issues where document_id = ${doc.id} and status = 'open' limit 1`;
    await expectPgError(
      as(w, w.showcase.users.staff, (tx) => tx`select apply_review_changes(${doc.id}, ${doc.version}, ${w.sql.json([{ op: "accept_issue", issue_id: issue.id, reason: "  " }])})`),
      "22023",
    );
    const confirmed = await pickDoc("confirmed");
    await expectPgError(as(w, w.showcase.users.staff, (tx) => tx`select apply_review_changes(${confirmed.id}, ${confirmed.version}, '[]'::jsonb)`), "55000");
    await expectPgError(as(w, w.showcase.users.staff, (tx) => tx`select reopen_document(${confirmed.id}, '')`), "22023");
    await as(w, w.showcase.users.staff, (tx) => tx`select reopen_document(${confirmed.id}, '金額を直すため')`);
    const [d] = await w.sql<{ status: string; confirmed_at: Date | null }[]>`select status, confirmed_at from documents where id = ${confirmed.id}`;
    expect(d.status === "ready" || d.status === "needs_review").toBe(true);
    expect(d.confirmed_at).toBeNull();
    // 確定時の値の記録は残る
    const [{ n }] = await w.sql<{ n: number }[]>`select count(*)::int n from document_confirmations where document_id = ${confirmed.id}`;
    expect(n).toBeGreaterThan(0);
  });
});

describe("管理者・設定の保護", () => {
  it("自分の役割・利用状態は変更できない", async () => {
    await expectPgError(as(w, w.other.users.admin, (tx) => tx`select update_member(${w.other.users.admin}, 'staff', true)`), "42501");
  });

  it("有効な管理者が1人もいなくなる変更は、どの経路でも断る", async () => {
    // DB の所有者として直接変えても断る（トリガー）
    await expectPgError(w.sql`update organization_members set role = 'staff' where user_id = ${w.other.users.admin}`, "23514");
    await expectPgError(w.sql`update organization_members set is_active = false where user_id = ${w.other.users.admin}`, "23514");
    // ほかに管理者がいれば変えられる
    await as(w, w.other.users.admin, (tx) => tx`select update_member(${w.other.users.staff}, 'admin', true)`);
    await w.sql`update organization_members set role = 'staff' where user_id = ${w.other.users.admin}`;
    await w.sql`update organization_members set role = 'admin' where user_id = ${w.other.users.admin}`;
    await as(w, w.other.users.admin, (tx) => tx`select update_member(${w.other.users.staff}, 'staff', true)`);
  });

  it("設定の変更は前後の値を操作の記録に残す。担当者はその記録を読めない", async () => {
    await as(w, w.other.users.admin, (tx) => tx`select update_org_settings(8, 12, 0.85, 500000, true)`);
    const [log] = await w.sql<{ detail: { before: Record<string, unknown>; after: Record<string, unknown> } }[]>`
      select detail from audit_logs where organization_id = ${w.other.id} and action = 'settings.update' order by created_at desc limit 1`;
    expect(log.detail.after).toMatchObject({ max_file_mb: 8, max_pages: 12, staff_confirm_limit: 500000, llm_enabled: true });
    expect(log.detail.before).toMatchObject({ llm_enabled: false });
    const seen = await as(w, w.other.users.staff, (tx) => tx`select 1 from audit_logs where action = 'settings.update'`);
    expect(seen.length).toBe(0);
  });

  it("デモ環境では外部の AI を有効にできず、メンバーも追加できない", async () => {
    await expectPgError(as(w, w.demo.users.admin, (tx) => tx`select update_org_settings(10, 10, 0.8, null, true)`), "42501", /デモ環境/);
    await expectPgError(as(w, w.demo.users.admin, (tx) => tx`select admin_add_member('new@example.com', '新しい人', 'staff', 'scrypt$abc')`), "42501", /デモ環境/);
    // AI を使わない設定の変更はできる
    await as(w, w.demo.users.admin, (tx) => tx`select update_org_settings(10, 10, 0.8, null, false)`);
  });

  it("デモの片付けは期限切れの組織とその匿名の利用者だけを消す", async () => {
    await w.sql`update organizations set demo_expires_at = now() - interval '1 minute' where id = ${w.demo.id}`;
    const [{ n }] = await w.sql<{ n: number }[]>`select app_private.demo_cleanup() n`;
    expect(n).toBe(1);
    const left = await w.sql`select 1 from organizations where id = ${w.demo.id}`;
    expect(left.length).toBe(0);
    const users = await w.sql`select 1 from app_auth.users where id = ${w.demo.users.admin}`;
    expect(users.length).toBe(0);
    const [{ showcase }] = await w.sql<{ showcase: number }[]>`select count(*)::int showcase from documents where organization_id = ${w.showcase.id}`;
    expect(showcase).toBeGreaterThan(30);
  });
});
