import "server-only";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { serverEnv } from "@/lib/env";
import { runAsUser } from "./rls";
import { toPostgresJsUrl } from "./url";
import { DB_TYPES } from "./types";

declare global {
  var __dfSql: Sql | undefined;
}

/**
 * データベース接続（サーバー専用）。
 * 公開環境では接続プーラー（Neon の PgBouncer・Supabase の Supavisor の Transaction モード）を通すため prepare: false。
 */
export function db(): Sql {
  globalThis.__dfSql ??= postgres(toPostgresJsUrl(serverEnv.databaseUrl), {
    prepare: false,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    types: DB_TYPES,
  });
  return globalThis.__dfSql;
}

export type Tx = TransactionSql;

/** ログインユーザーの権限（RLS）で実行する */
export function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>, organizationId?: string | null): Promise<T> {
  return runAsUser(db(), userId, fn, organizationId);
}
