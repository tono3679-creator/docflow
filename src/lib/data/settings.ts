import "server-only";
/** 設定画面のデータ（メンバー・AI と OCR の利用量）。管理者だけが使う */
import { db, type Tx } from "@/lib/db";
import type { OrgRole } from "@/lib/domain/labels";

export type MemberRow = { user_id: string; display_name: string; email: string | null; role: OrgRole; is_active: boolean; is_anonymous: boolean };

/**
 * 組織のメンバー。メールアドレスはログインの表（ログイン利用者からは読めない）にあるため、
 * 管理者であることを確かめた画面からだけ、組織の ID で絞って読む。
 */
export async function listMembers(organizationId: string): Promise<MemberRow[]> {
  return db()<MemberRow[]>`
    select m.user_id, p.display_name, u.email, m.role, m.is_active, u.is_anonymous
      from organization_members m
      join profiles p on p.id = m.user_id
      join app_auth.users u on u.id = m.user_id
     where m.organization_id = ${organizationId}
     order by case m.role when 'admin' then 0 when 'staff' then 1 else 2 end, p.display_name`;
}

export type UsageRow = {
  kind: "pdf_text" | "ocr" | "llm";
  provider: string;
  model: string | null;
  calls: number;
  pages: number;
  input_tokens: number;
  output_tokens: number;
  failures: number;
  avg_ms: number | null;
};

/** 今月の利用量（読み取りの方法・提供元・モデルごと） */
export async function usageThisMonth(tx: Tx, timezone: string): Promise<UsageRow[]> {
  return tx<UsageRow[]>`
    select kind, provider, nullif(model, '') model, count(*)::int calls, coalesce(sum(pages), 0)::int pages,
           coalesce(sum(input_tokens), 0)::int input_tokens, coalesce(sum(output_tokens), 0)::int output_tokens,
           count(*) filter (where not success)::int failures, round(avg(duration_ms))::int avg_ms
      from ai_usage_logs
     where created_at >= (date_trunc('month', now() at time zone ${timezone}) at time zone ${timezone})
     group by kind, provider, nullif(model, '')
     order by kind, provider`;
}
