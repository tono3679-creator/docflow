/**
 * DB のテストの準備。テスト専用のデータベース（既定 docflow_test）を作り直し、マイグレーションと見本の組織を入れる。
 *   TEST_DATABASE_URL  … 使うデータベース（名前が _test で終わるものだけ。作り直すため）
 * アプリの db()（worker など）もこのデータベースを使うよう、DATABASE_URL を置き換える。
 */
import postgres, { type Sql, type TransactionSql } from "postgres";
import { expect } from "vitest";
import { migrate } from "../../scripts/db/migrate";
import { cloneTemplate } from "@/lib/demo/sandbox";
import { seedShowcase } from "@/lib/demo/showcase";
import { runAsUser } from "@/lib/db/rls";
import { DB_TYPES } from "@/lib/db/types";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/docflow_test";
process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = "";

type Persona = "admin" | "staff" | "viewer";
export type Org = { id: string; users: Record<Persona, string> };
export type World = { sql: Sql; showcase: Org; other: Org; demo: Org };

export async function prepareTestDb(): Promise<World> {
  const url = new URL(TEST_DB_URL);
  const name = url.pathname.slice(1);
  if (!/_test$/.test(name)) throw new Error(`テスト用のデータベース名は _test で終わるものにしてください（${name}）`);
  const adminUrl = new URL(TEST_DB_URL);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const sql = postgres(TEST_DB_URL, { max: 6, prepare: false, onnotice: () => {}, types: DB_TYPES });
  await migrate(sql, () => {});
  await seedShowcase(sql, { password: "test-password-0001", log: () => {} });
  const showcase = await orgOf(sql, "is_showcase");
  const other = await sql.begin((tx) =>
    cloneTemplate(tx, {
      name: "株式会社テスト別会社",
      isDemo: false,
      isShowcase: false,
      users: (["admin", "staff", "viewer"] as const).map((role) => ({ role, name: `別会社 ${role}`, email: `${role}@other.example`, passwordHash: null })),
    }),
  );
  const demo = await sql.begin((tx) =>
    cloneTemplate(tx, {
      name: "株式会社山田商事",
      isDemo: true,
      isShowcase: false,
      users: (["admin", "staff", "viewer"] as const).map((role) => ({ role, name: `デモ ${role}`, email: null, passwordHash: null })),
    }),
  );
  return { sql, showcase, other: { id: other.organizationId, users: other.users }, demo: { id: demo.organizationId, users: demo.users } };
}

async function orgOf(sql: Sql, flag: "is_showcase"): Promise<Org> {
  const rows = await sql<{ organization_id: string; user_id: string; role: Persona }[]>`
    select m.organization_id, m.user_id, m.role from organization_members m join organizations o on o.id = m.organization_id
     where o.${sql(flag)} order by m.created_at`;
  const users = {} as Record<Persona, string>;
  for (const r of rows) users[r.role] ??= r.user_id;
  return { id: rows[0].organization_id, users };
}

/** ログイン利用者として実行する（アプリと同じ方法：ロール authenticated・JWT の sub） */
export function as<T>(world: World, userId: string, fn: (tx: TransactionSql) => Promise<T>, orgId?: string): Promise<T> {
  return runAsUser(world.sql, userId, fn, orgId);
}

/** PostgreSQL のエラーコードで失敗することを確かめる */
export async function expectPgError(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string; message?: string },
  );
  expect(err, `エラー ${code} になるはずが成功した`).not.toBeNull();
  expect(err!.code).toBe(code);
  if (message) expect(err!.message).toMatch(message);
}
