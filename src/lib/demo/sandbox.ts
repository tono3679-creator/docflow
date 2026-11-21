import "server-only";
/**
 * 訪問者ごとのデモ環境。元データ（is_template）を丸ごと複製した組織を作る（ほかの訪問者の操作は見えない・混ざらない）。
 * 24時間で期限切れになり、毎日の定期処理で消える。「初期状態に戻す」は作り直し。
 */
import type { TransactionSql } from "postgres";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { DEMO_COMPANY, DEMO_PEOPLE } from "./template";

export const DEMO_TTL_HOURS = 24;
export type DemoPersona = "admin" | "staff" | "viewer";
export const DEMO_PERSONAS: DemoPersona[] = ["admin", "staff", "viewer"];

export class DemoCapacityError extends Error {
  constructor() {
    super("デモ環境の上限に達しています");
    this.name = "DemoCapacityError";
  }
}

export class DemoNotReadyError extends Error {
  constructor() {
    super("デモの元データがありません（npm run db:seed を実行してください）");
    this.name = "DemoNotReadyError";
  }
}

export async function ensureDemoCapacity(): Promise<void> {
  const sql = db();
  const count = async () => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int n from organizations where is_demo and demo_expires_at > now()`;
    return row.n;
  };
  if ((await count()) < serverEnv.demoMaxActive) return;
  await sql`select app_private.demo_cleanup()`;
  if ((await count()) >= serverEnv.demoMaxActive) throw new DemoCapacityError();
}

async function deleteDemoOrg(tx: TransactionSql, userId: string) {
  const rows = await tx<{ organization_id: string }[]>`
    select m.organization_id from organization_members m join organizations o on o.id = m.organization_id
     where m.user_id = ${userId} and o.is_demo`;
  if (!rows[0]) return;
  const users = await tx<{ user_id: string }[]>`select user_id from organization_members where organization_id = ${rows[0].organization_id}`;
  await tx`delete from organizations where id = ${rows[0].organization_id}`;
  await tx`delete from app_auth.users where id = any(${users.map((u) => u.user_id)}::uuid[]) and is_anonymous`;
}

/** 元データの組織を複製する（訪問者のデモ・見本の組織の共通部分） */
export async function cloneTemplate(
  tx: TransactionSql,
  target: { name: string; isDemo: boolean; isShowcase: boolean; users: { role: DemoPersona; name: string; email: string | null; passwordHash: string | null }[] },
): Promise<{ organizationId: string; users: Record<DemoPersona, string> }> {
  const [template] = await tx<{ id: string; created_at: Date }[]>`select id, created_at from organizations where is_template order by created_at desc limit 1`;
  if (!template) throw new DemoNotReadyError();
  const [org] = await tx<{ id: string }[]>`
    insert into organizations (name, is_demo, demo_expires_at, is_showcase)
    values (${target.name}, ${target.isDemo}, ${target.isDemo ? new Date(Date.now() + DEMO_TTL_HOURS * 3600_000) : null}, ${target.isShowcase})
    returning id`;
  const [settings] = await tx<{ staff_confirm_limit: number | null; confidence_threshold: number }[]>`
    select staff_confirm_limit, confidence_threshold from organization_settings where organization_id = ${template.id}`;
  await tx`insert into organization_settings (organization_id, staff_confirm_limit, confidence_threshold)
           values (${org.id}, ${settings?.staff_confirm_limit ?? null}, ${settings?.confidence_threshold ?? 0.8})`;
  const templateUsers = await tx<{ user_id: string; role: DemoPersona }[]>`
    select user_id, role from organization_members where organization_id = ${template.id}`;
  const users = {} as Record<DemoPersona, string>;
  const map: Record<string, string> = {};
  for (const u of target.users) {
    const [row] = await tx<{ id: string }[]>`
      insert into app_auth.users (email, encrypted_password, is_anonymous) values (${u.email}, ${u.passwordHash}, ${u.email === null}) returning id`;
    await tx`insert into profiles (id, display_name) values (${row.id}, ${u.name})`;
    await tx`insert into organization_members (organization_id, user_id, role) values (${org.id}, ${row.id}, ${u.role})`;
    users[u.role] = row.id;
    const from = templateUsers.find((t) => t.role === u.role);
    if (from) map[from.user_id] = row.id;
  }
  await tx`select app_private.clone_documents(${template.id}, ${org.id}, ${tx.json(map)}, ${`${Math.round((Date.now() - template.created_at.getTime()) / 1000)} seconds`}::interval)`;
  return { organizationId: org.id, users };
}

/** 訪問者専用のデモ組織を作り、選んだ役割の利用者の ID を返す。previousUserId のデモ組織は同じトランザクションで消す（初期化） */
export async function createDemoSandbox(persona: DemoPersona, previousUserId?: string): Promise<{ userId: string; organizationId: string }> {
  return db().begin(async (tx) => {
    if (previousUserId) await deleteDemoOrg(tx, previousUserId);
    const out = await cloneTemplate(tx, {
      name: DEMO_COMPANY,
      isDemo: true,
      isShowcase: false,
      users: DEMO_PEOPLE.map((p) => ({ role: p.role, name: p.name, email: null, passwordHash: null })),
    });
    return { userId: out.users[persona], organizationId: out.organizationId };
  });
}

export async function demoColleague(organizationId: string, persona: DemoPersona): Promise<string | null> {
  const [row] = await db()<{ user_id: string }[]>`
    select m.user_id from organization_members m
      join organizations o on o.id = m.organization_id and o.is_demo and o.demo_expires_at > now()
      join app_auth.users u on u.id = m.user_id and u.is_anonymous
     where m.organization_id = ${organizationId} and m.role = ${persona}
     order by m.created_at limit 1`;
  return row?.user_id ?? null;
}

export async function deleteDemoOf(userId: string): Promise<void> {
  await db().begin((tx) => deleteDemoOrg(tx, userId));
}
