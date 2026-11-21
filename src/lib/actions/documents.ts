"use server";
/**
 * 確認画面・一覧の操作（Server Actions）。
 * 画面の役割の確認に加えて、DB の関数が役割・書類の状態・版番号（同時編集）を確かめる。
 * 値を変えたあとは、必ず検証をやり直して保存する（確定できるかは DB の関数が保存された検証結果で判断する）。
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { asCurrentUser, requireUser } from "@/lib/auth";
import { can } from "@/lib/domain/labels";
import { syncValidationAsUser } from "@/lib/documents/validation";
import { fieldDef, lineFieldDef, LINE_KEYS } from "@/lib/extraction/schema";
import { normalizeValue } from "@/lib/extraction/normalize";
import type { DocumentType } from "@/lib/extraction/types";
import { deleteFileIfUnused } from "@/lib/storage";
import { toUserMessage } from "./errors";
import type { ActionResult } from "./result";

const uuid = z.uuid();
const NO_PERMISSION: ActionResult<never> = { ok: false, error: "この操作を行う権限がありません" };
const STALE = "この書類は他の操作で更新されています。画面を再読み込みしてください";

function failure(e: unknown, fallback?: string): ActionResult<never> {
  const message = toUserMessage(e, fallback);
  return { ok: false, error: message, ...(message === STALE ? { stale: true as const } : {}) };
}

function refresh(id?: string) {
  revalidatePath("/documents");
  revalidatePath("/dashboard");
  if (id) revalidatePath(`/documents/${id}`);
}

export type ReviewChange =
  | { op: "set"; fieldId: string; value?: string | null; confirm?: boolean; unconfirm?: boolean }
  | { op: "add_line" }
  | { op: "remove_line"; line: number }
  | { op: "accept_issue"; issueId: string; reason: string }
  | { op: "reopen_issue"; issueId: string };

const changeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), fieldId: uuid, value: z.string().max(1000).nullable().optional(), confirm: z.boolean().optional(), unconfirm: z.boolean().optional() }),
  z.object({ op: z.literal("add_line") }),
  z.object({ op: z.literal("remove_line"), line: z.number().int().min(0).max(500) }),
  z.object({ op: z.literal("accept_issue"), issueId: uuid, reason: z.string().trim().min(1, "承認の理由を入力してください").max(300) }),
  z.object({ op: z.literal("reopen_issue"), issueId: uuid }),
]);

/**
 * 修正・確認・承認をまとめて保存する。値を直しただけでは「確認済み」にしない（confirm を付けたときだけ）。
 * 値は項目の種類に合わせて整える（「¥1,200」→ 1200、「2026/11/1」→ 2026-11-01）。解釈できなければ入力のまま保存し、検証で知らせる。
 */
export async function saveReview(documentId: string, version: number, changes: ReviewChange[]): Promise<ActionResult<{ version: number; openIssues: number | null }>> {
  const user = await requireUser();
  if (!can.review(user.role)) return NO_PERMISSION;
  if (!uuid.safeParse(documentId).success || !Number.isInteger(version)) return { ok: false, error: "不正な操作です" };
  const parsed = z.array(changeSchema).min(1).max(300).safeParse(changes);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "入力内容を確認してください" };
  try {
    const result = await asCurrentUser(async (tx) => {
      const [doc] = await tx<{ document_type: DocumentType | null }[]>`select document_type from documents where id = ${documentId}`;
      if (!doc) throw Object.assign(new Error("書類が見つかりません"), { code: "P0002" });
      const keys = new Map((await tx<{ id: string; field_key: string; line_index: number | null }[]>`
        select id, field_key, line_index from document_fields where document_id = ${documentId}`).map((f) => [f.id, f]));
      const [maxLine] = await tx<{ n: number | null }[]>`select max(line_index) n from document_line_items where document_id = ${documentId}`;
      const [maxFieldLine] = await tx<{ n: number | null }[]>`select max(line_index) n from document_fields where document_id = ${documentId}`;
      let nextLine = Math.max(maxLine.n ?? -1, maxFieldLine.n ?? -1) + 1;
      const ops = parsed.data.map((c) => {
        switch (c.op) {
          case "set": {
            const f = keys.get(c.fieldId);
            const kind = f ? (f.line_index === null ? fieldDef(doc.document_type, f.field_key)?.kind : lineFieldDef(f.field_key)?.kind) : undefined;
            const op: Record<string, unknown> = { op: "set", field_id: c.fieldId };
            if (c.value !== undefined) op.value = c.value === null ? "" : normalizeValue(kind, c.value) ?? "";
            if (c.confirm) op.review_status = "confirmed";
            else if (c.unconfirm) op.review_status = "unreviewed";
            return op;
          }
          case "add_line":
            return { op: "add_line", line_index: nextLine++, keys: LINE_KEYS };
          case "remove_line":
            return { op: "remove_line", line_index: c.line };
          case "accept_issue":
            return { op: "accept_issue", issue_id: c.issueId, reason: c.reason };
          case "reopen_issue":
            return { op: "reopen_issue", issue_id: c.issueId };
        }
      });
      const [row] = await tx<{ v: number }[]>`select apply_review_changes(${documentId}, ${version}, ${tx.json(ops as never)}) v`;
      const openIssues = await syncValidationAsUser(tx, user.organizationId, documentId);
      return { version: row.v, openIssues };
    });
    refresh(documentId);
    return { ok: true, data: result };
  } catch (e) {
    return failure(e);
  }
}

/** 書類を確定する。直前に検証をやり直し、未対応の確認事項・未判断の重複があれば DB の関数が断る */
export async function confirmDocument(documentId: string, version: number): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.review(user.role)) return NO_PERMISSION;
  if (!uuid.safeParse(documentId).success) return { ok: false, error: "不正な操作です" };
  try {
    await asCurrentUser(async (tx) => {
      await syncValidationAsUser(tx, user.organizationId, documentId);
      await tx`select confirm_document(${documentId}, ${version})`;
    });
    refresh(documentId);
    return { ok: true };
  } catch (e) {
    return failure(e, "確定できませんでした");
  }
}

export async function reopenDocument(documentId: string, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.review(user.role)) return NO_PERMISSION;
  const r = z.string().trim().min(1, "再確認の理由を入力してください").max(300).safeParse(reason);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  try {
    await asCurrentUser(async (tx) => {
      await tx`select reopen_document(${documentId}, ${r.data})`;
      await syncValidationAsUser(tx, user.organizationId, documentId);
    });
    refresh(documentId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

/** 読み直し。type を指定すると、その書類種別として項目を取り出し直す（読み取った文字は使い回す） */
export async function reprocessDocument(documentId: string, type: DocumentType | null = null): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.review(user.role)) return NO_PERMISSION;
  if (!uuid.safeParse(documentId).success) return { ok: false, error: "不正な操作です" };
  if (type !== null && !["invoice", "receipt", "delivery_note"].includes(type)) return { ok: false, error: "書類種別を選んでください" };
  try {
    await asCurrentUser((tx) => tx`select request_extraction(${documentId}, ${type}::document_type)`);
    refresh(documentId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

/** 一覧からまとめて読み直す（エラーの書類など） */
export async function reprocessMany(ids: string[]): Promise<ActionResult<{ count: number; failed: number }>> {
  const user = await requireUser();
  if (!can.review(user.role)) return NO_PERMISSION;
  const parsed = z.array(uuid).min(1).max(200).safeParse(ids);
  if (!parsed.success) return { ok: false, error: "書類を選んでください" };
  let count = 0;
  let failed = 0;
  for (const id of parsed.data) {
    try {
      await asCurrentUser((tx) => tx`select request_extraction(${id}, null)`);
      count++;
    } catch {
      failed++;
    }
  }
  refresh();
  return { ok: true, data: { count, failed } };
}

/** 重複の判断。「重複」を選ぶと、この書類を除外する（削除はしない） */
export async function decideDuplicate(candidateId: string, decision: "duplicate" | "not_duplicate" | "pending"): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.review(user.role)) return NO_PERMISSION;
  if (!uuid.safeParse(candidateId).success || !["duplicate", "not_duplicate", "pending"].includes(decision)) return { ok: false, error: "不正な操作です" };
  try {
    const documentId = await asCurrentUser(async (tx) => {
      const [row] = await tx<{ id: string }[]>`select decide_duplicate(${candidateId}, ${decision}::duplicate_status) id`;
      await syncValidationAsUser(tx, user.organizationId, row.id);
      if (decision === "duplicate") await tx`select set_document_excluded(${row.id}, true, '重複と判断')`;
      return row.id;
    });
    refresh(documentId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

export async function setExcluded(documentId: string, excluded: boolean, reason = ""): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.review(user.role)) return NO_PERMISSION;
  if (!uuid.safeParse(documentId).success) return { ok: false, error: "不正な操作です" };
  try {
    await asCurrentUser(async (tx) => {
      await tx`select set_document_excluded(${documentId}, ${excluded}, ${reason.slice(0, 300)})`;
      if (!excluded) await syncValidationAsUser(tx, user.organizationId, documentId);
    });
    refresh(documentId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

/** 削除（管理者のみ）。ほかの書類が同じファイルを使っていなければ、ファイル本体も消す */
export async function deleteDocument(documentId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can.delete(user.role)) return NO_PERMISSION;
  if (!uuid.safeParse(documentId).success) return { ok: false, error: "不正な操作です" };
  try {
    const paths = await asCurrentUser((tx) => tx<{ storage_path: string; preview_path: string | null }[]>`select * from delete_document(${documentId})`);
    for (const p of paths) {
      await deleteFileIfUnused(p.storage_path);
      await deleteFileIfUnused(p.preview_path);
    }
    refresh();
    return { ok: true };
  } catch (e) {
    return failure(e, "削除できませんでした");
  }
}
