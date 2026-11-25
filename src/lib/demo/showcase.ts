/**
 * 見本の組織（メールアドレスとパスワードでログインする「株式会社山田商事」）と、デモの元データを作り直す。
 * Seed（npm run db:seed）・公開時のビルドから使う。
 * ログイン：admin@ / staff@ / viewer@docflow.example（パスワードは SEED_LOGIN_PASSWORD）
 */
import type { Sql } from "postgres";
import { hashPassword } from "../password";
import { cloneTemplate } from "./sandbox";
import { buildTemplate, DEMO_COMPANY, DEMO_PEOPLE } from "./template";

export async function seedShowcase(sql: Sql, opts: { password: string; now?: Date; log?: (s: string) => void }) {
  const log = opts.log ?? console.log;
  await buildTemplate(sql, { now: opts.now, log });
  const hash = await hashPassword(opts.password);
  const emails = DEMO_PEOPLE.map((p) => p.email);
  await sql.begin(async (tx) => {
    await tx`delete from organizations where is_showcase`;
    await tx`delete from app_auth.users where lower(email) = any(${emails}::text[])`;
    await cloneTemplate(tx, {
      name: DEMO_COMPANY,
      isDemo: false,
      isShowcase: true,
      users: DEMO_PEOPLE.map((p) => ({ role: p.role, name: p.name, email: p.email, passwordHash: hash })),
    });
  });
  log(`見本の組織を作り直しました（ログイン：${emails.join(" / ")}）`);
}
