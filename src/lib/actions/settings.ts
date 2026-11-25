"use server";
/**
 * 設定とメンバー（管理者のみ）。画面の役割の確認に加えて、DB の関数が管理者かを確かめ、変更を記録する。
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { asCurrentUser, requireUser } from "@/lib/auth";
import { can, ROLES } from "@/lib/domain/labels";
import { hashPassword } from "@/lib/password";
import { run, uuidSchema, validate } from "./helpers";
import type { ActionResult } from "./result";

const NO_PERMISSION: ActionResult<never> = { ok: false, error: "この操作を行う権限がありません" };

const intIn = (label: string, min: number, max: number) =>
  z.coerce.number({ error: `${label}を数字で入力してください` }).int(`${label}は整数で入力してください`).min(min, `${label}は ${min} 以上にしてください`).max(max, `${label}は ${max} 以下にしてください`);

const settingsSchema = z.object({
  maxFileMb: intIn("ファイルの上限", 1, 20),
  maxPages: intIn("ページ数の上限", 1, 50),
  thresholdPercent: intIn("信頼度のしきい値", 50, 99),
  staffConfirmLimit: z.union([z.literal(""), z.coerce.number().int("整数で入力してください").min(0, "0 以上にしてください").max(999_999_999_999, "大きすぎます")]),
  llmEnabled: z.boolean(),
});

export type SettingsInput = z.input<typeof settingsSchema>;

export async function updateSettings(input: SettingsInput): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.settings(user.role)) return NO_PERMISSION;
  const v = validate(settingsSchema, input);
  if (!v.ok) return v.result;
  const d = v.data;
  const r = await run(() => asCurrentUser((tx) => tx`
    select update_org_settings(${d.maxFileMb}, ${d.maxPages}, ${(d.thresholdPercent / 100).toFixed(2)}::numeric,
                               ${d.staffConfirmLimit === "" ? null : d.staffConfirmLimit}::bigint, ${d.llmEnabled})`));
  if (!r.ok) return r.result;
  revalidatePath("/settings");
  revalidatePath("/upload");
  return { ok: true };
}

const memberSchema = z.object({
  userId: uuidSchema,
  role: z.enum(ROLES),
  active: z.boolean(),
});

export async function updateMember(input: z.input<typeof memberSchema>): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.settings(user.role)) return NO_PERMISSION;
  const v = validate(memberSchema, input);
  if (!v.ok) return v.result;
  const r = await run(() => asCurrentUser((tx) => tx`select update_member(${v.data.userId}, ${v.data.role}::org_role, ${v.data.active})`));
  if (!r.ok) return r.result;
  revalidatePath("/settings");
  return { ok: true };
}

const addSchema = z.object({
  email: z.email("メールアドレスの形式が正しくありません").max(200),
  displayName: z.string().trim().min(1, "名前を入力してください").max(50, "名前は50文字までです"),
  role: z.enum(ROLES),
  password: z.string().min(10, "パスワードは10文字以上にしてください").max(200),
});

export async function addMember(input: z.input<typeof addSchema>): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.settings(user.role)) return NO_PERMISSION;
  if (user.isDemo) return { ok: false, error: "デモ環境ではメンバーを追加できません" };
  const v = validate(addSchema, input);
  if (!v.ok) return v.result;
  const hash = await hashPassword(v.data.password);
  const r = await run(() => asCurrentUser((tx) => tx`select admin_add_member(${v.data.email}, ${v.data.displayName}, ${v.data.role}::org_role, ${hash})`));
  if (!r.ok) return r.result;
  revalidatePath("/settings");
  return { ok: true };
}
