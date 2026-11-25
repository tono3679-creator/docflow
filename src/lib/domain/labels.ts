/** 画面に出す名前（DB の値 → 日本語）と、役割ごとにできること */

export type OrgRole = "admin" | "staff" | "viewer";
export const ROLE_LABEL: Record<OrgRole, string> = { admin: "管理者", staff: "担当者", viewer: "閲覧者" };
export const ROLES: OrgRole[] = ["admin", "staff", "viewer"];

export type DocumentStatus = "queued" | "processing" | "needs_review" | "ready" | "confirmed" | "error" | "excluded";
/**
 * 書類の状態。指示書の「未処理／処理中／要確認／処理済み／エラー」に、
 * 確認事項が無く確定を待つ「確認待ち」と、重複などで外した「除外」を加えている。
 */
export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  queued: "未処理",
  processing: "処理中",
  needs_review: "要確認",
  ready: "確認待ち",
  confirmed: "処理済み",
  error: "エラー",
  excluded: "除外",
};
export const DOCUMENT_STATUSES: DocumentStatus[] = ["queued", "processing", "needs_review", "ready", "confirmed", "error", "excluded"];

export type ValidationStatus = "ok" | "needs_review" | "inconsistent" | "missing";
/** 項目の状態。「正常」は検証で問題を見つけていないという意味（正しさの保証ではない） */
export const FIELD_STATUS_LABEL: Record<ValidationStatus | "confirmed", string> = {
  ok: "正常",
  needs_review: "要確認",
  inconsistent: "不整合",
  missing: "未取得",
  confirmed: "確認済み",
};

export const REVIEW_ACTION_LABEL: Record<string, string> = {
  edit: "値を修正",
  confirm_field: "項目を確認",
  unconfirm_field: "確認を取り消し",
  accept_issue: "理由を付けて承認",
  reopen_issue: "承認を取り消し",
  add_line: "明細を追加",
  remove_line: "明細を削除",
  change_type: "書類種別を変更",
  confirm_document: "書類を確定",
  reopen_document: "確定を取り消し（再確認）",
  duplicate_decision: "重複を判断",
  exclude: "除外",
  restore: "除外を取り消し",
};

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  "document.upload": "アップロード",
  "document.reprocess": "読み直し",
  "document.confirm": "確定",
  "document.reopen": "再確認",
  "document.exclude": "除外",
  "document.restore": "除外を取り消し",
  "document.delete": "削除",
  "document.processed": "読取完了",
  "document.failed": "読取失敗",
  "export.create": "出力",
  "member.add": "メンバー追加",
  "member.update": "メンバー変更",
  "settings.update": "設定変更",
};

/** 役割ごとにできること（画面の出し分け。最終的な判断は DB の関数と RLS） */
export const can = {
  upload: (r: OrgRole) => r === "admin" || r === "staff",
  review: (r: OrgRole) => r === "admin" || r === "staff",
  export: (r: OrgRole) => r === "admin" || r === "staff",
  delete: (r: OrgRole) => r === "admin",
  settings: (r: OrgRole) => r === "admin",
  auditAll: (r: OrgRole) => r === "admin",
};
