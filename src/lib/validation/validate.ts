/**
 * 書類の検証。項目の今の値から「確認事項（issues）」「項目の状態」「金額の照合」「一覧用の要約」を作る。
 * 読取の直後（worker）と、利用者が修正・確認するたび（Server Action）に同じ関数で計算する。
 *
 * 状態の意味：
 *   ok           … 検証上の問題を見つけていない（正しいことの保証ではない）
 *   needs_review … 読取が不確か（信頼度が低い・原本の位置が不明・形式が不自然・検証不能）→ 項目を「確認済み」にすると解消
 *   inconsistent … 計算や項目どうしの矛盾 → 値を直すか、理由を付けて承認すると解消
 *   missing      … 値を読み取れていない（必須なら確認事項になる）
 */
import { DATE_KEY, FIELD_DEFS, NUMBER_KEY, fieldDef, isKnownType, lineFieldDef } from "../extraction/schema";
import type { DocumentContext, DocumentType } from "../extraction/types";
import { DUPLICATE_REASON, type DupMatch } from "./duplicates";
import { reconcile, type AmountCheck } from "./reconcile";
import { isIntegerString, isIsoDate, parseDecimalMilli, parseRegistrationNumber, parseTaxRate } from "./values";

export type FieldState = {
  id: string;
  key: string;
  line: number | null;
  value: string | null;
  hasSource: boolean;
  conf: number | null;
  source: "pdf_text" | "ocr" | "user";
  reviewStatus: "unreviewed" | "confirmed";
};

export type IssueType =
  | "low_confidence" | "ambiguous" | "invalid_format" | "date_format" | "date_order" | "amount_mismatch" | "tax_mismatch"
  | "unverifiable" | "missing_required" | "no_source" | "conflict" | "duplicate" | "type_unknown" | "read_failed";

export type IssueOut = {
  key: string;
  fieldId: string | null;
  type: IssueType;
  severity: "warning" | "error";
  reason: string;
  detail: Record<string, unknown> & { sig?: string };
};

export type ValidateInput = {
  documentType: DocumentType | null;
  fields: FieldState[];
  /** 読取で見つかった、同じ項目の別の記載（キー：issuer_name、line.2.amount など） */
  conflicts: Record<string, string[]>;
  context: DocumentContext;
  threshold: number;
  /** 判断していない重複の候補 */
  duplicates: DupMatch[];
  /** 承認済みの確認事項（キー → 承認したときの sig） */
  accepted: Record<string, string | null>;
};

export type ValidationStatus = "ok" | "needs_review" | "inconsistent" | "missing";

export type ValidateResult = {
  issues: IssueOut[];
  fieldStatuses: { id: string; status: ValidationStatus }[];
  checks: AmountCheck[];
  summary: { issuer_name: string | null; document_number: string | null; issue_date: string | null; total_amount: number | null };
};

const refKey = (key: string, line: number | null) => (line === null ? key : `line.${line}.${key}`);

export function validateDocument(input: ValidateInput): ValidateResult {
  const issues: IssueOut[] = [];
  const type = input.documentType;
  const byRef = new Map(input.fields.map((f) => [refKey(f.key, f.line), f]));
  const header = (key: string) => byRef.get(refKey(key, null)) ?? null;
  const int = (key: string) => {
    const v = header(key)?.value;
    return isIntegerString(v) ? Number(v) : null;
  };

  if (!input.context.textFound) {
    issues.push({ key: "read_failed", fieldId: null, type: "read_failed", severity: "error", reason: "文字を読み取れません", detail: {} });
  }
  if (!isKnownType(type)) {
    issues.push({ key: "type_unknown", fieldId: null, type: "type_unknown", severity: "error", reason: "書類種別を判定できません", detail: {} });
  }

  // 項目ごと
  for (const f of input.fields) {
    const label = f.line === null ? (fieldDef(type, f.key)?.label ?? f.key) : `明細${f.line + 1} ${lineFieldDef(f.key)?.label ?? f.key}`;
    const def = f.line === null ? fieldDef(type, f.key) : undefined;
    const kind = f.line === null ? def?.kind : lineFieldDef(f.key)?.kind;
    const confirmed = f.reviewStatus === "confirmed";
    const k = refKey(f.key, f.line);
    if (f.value === null) {
      if (def?.required) {
        issues.push({ key: `missing:${k}`, fieldId: f.id, type: "missing_required", severity: "error", reason: "必須項目が未取得", detail: { label } });
      }
      continue;
    }
    // 形式（直すか、確認済みにすると解消）
    let formatReason: string | null = null;
    let formatType: IssueType = "invalid_format";
    if (kind === "date" && !isIsoDate(f.value)) {
      formatReason = "日付の形式が不明";
      formatType = "date_format";
    } else if (kind === "amount" && !isIntegerString(f.value)) {
      formatReason = "金額の形式が不自然";
    } else if ((kind === "quantity" || kind === "unit_price") && parseDecimalMilli(f.value) === null) {
      formatReason = "数値の形式が不自然";
    } else if (kind === "reg_no" && !parseRegistrationNumber(f.value)) {
      formatReason = "登録番号の形式が不正（T＋13桁）";
    } else if (kind === "tax_rate" && !parseTaxRate(f.value)) {
      formatReason = "税率が不明";
    }
    if (formatReason && !confirmed) {
      issues.push({ key: `format:${k}`, fieldId: f.id, type: formatType, severity: "warning", reason: formatReason, detail: { label, value: f.value } });
    }
    if (!confirmed && f.source !== "user") {
      if (f.conf !== null && f.conf < input.threshold) {
        issues.push({
          key: `conf:${k}`, fieldId: f.id, type: "low_confidence", severity: "warning",
          reason: `文字が不鮮明（信頼度 ${Math.round(f.conf * 100)}%）`, detail: { label, confidence: f.conf },
        });
      }
      if (!f.hasSource) {
        issues.push({ key: `nosrc:${k}`, fieldId: f.id, type: "no_source", severity: "warning", reason: "原本の位置を特定できません", detail: { label } });
      }
    }
    const others = (input.conflicts[k] ?? []).filter((v) => v !== f.value);
    if (others.length > 0 && !confirmed) {
      issues.push({
        key: `conflict:${k}`, fieldId: f.id, type: "conflict", severity: "error",
        reason: `別の記載あり（${others.slice(0, 2).join("・")}）`, detail: { label, others },
      });
    }
  }

  // 日付の前後
  const issue = header("issue_date")?.value ?? null;
  const due = header("due_date");
  if (isIsoDate(issue) && due && isIsoDate(due.value) && due.value < issue && due.reviewStatus !== "confirmed") {
    issues.push({ key: "date_order:due_date", fieldId: due.id, type: "date_order", severity: "warning", reason: "支払期限が発行日より前", detail: { issue, due: due.value } });
  }

  // 金額の照合
  const lineIndexes = [...new Set(input.fields.filter((f) => f.line !== null).map((f) => f.line as number))].sort((a, b) => a - b);
  const lineValue = (line: number, key: string) => byRef.get(refKey(key, line))?.value ?? null;
  const checks = isKnownType(type)
    ? reconcile({
        subtotal: int("subtotal"),
        taxAmount: int("tax_amount"),
        total: int("total_amount"),
        discount: int("discount"),
        shipping: int("shipping_fee"),
        tax10Base: int("tax_10_base"),
        tax10: int("tax_10"),
        tax8Base: int("tax_8_base"),
        tax8: int("tax_8"),
        lines: lineIndexes.map((index) => {
          const amount = lineValue(index, "amount");
          return {
            index,
            quantityMilli: parseDecimalMilli(lineValue(index, "quantity")),
            unitPriceMilli: parseDecimalMilli(lineValue(index, "unit_price")),
            amount: isIntegerString(amount) ? Number(amount) : null,
            taxRate: parseTaxRate(lineValue(index, "tax_rate")),
          };
        }),
        taxIncluded: input.context.taxIncluded,
        rounding: input.context.rounding,
        statedRates: input.context.statedRates,
        hasReducedMarker: input.context.hasReducedMarker,
      })
    : [];

  for (const c of checks) {
    if (c.status === "match") continue;
    const primary = byRef.get(refKey(c.fields[0].key, c.fields[0].line));
    if (c.status === "mismatch") {
      issues.push({
        key: `check:${c.id}`, fieldId: primary?.id ?? null, type: c.id.startsWith("tax") ? "tax_mismatch" : "amount_mismatch",
        severity: "error", reason: c.id.startsWith("line") ? "数量×単価と不一致" : c.id.startsWith("tax") ? "消費税の計算と不一致" : c.id === "subtotal" ? "明細の合計と不一致" : "計算結果と不一致",
        detail: { sig: c.sig, check: c.id, explanation: c.reason, expected: c.expected, actual: c.actual, fields: c.fields },
      });
    } else if (primary && primary.reviewStatus !== "confirmed") {
      issues.push({
        key: `check:${c.id}`, fieldId: primary.id, type: "unverifiable", severity: "warning", reason: "計算方式が不明（検証不能）",
        detail: { sig: c.sig, check: c.id, explanation: c.reason },
      });
    }
  }

  for (const d of input.duplicates) {
    issues.push({ key: `dup:${d.otherId}`, fieldId: null, type: "duplicate", severity: "error", reason: DUPLICATE_REASON[d.kind], detail: { other: d.otherId, kind: d.kind, matched: d.matched } });
  }

  // 項目の状態（承認済みの不整合は赤にしない）
  const isAccepted = (i: IssueOut) => i.key in input.accepted && (input.accepted[i.key] ?? null) === (i.detail.sig ?? null);
  const statusById = new Map<string, ValidationStatus>();
  const rank: Record<ValidationStatus, number> = { ok: 0, missing: 1, needs_review: 2, inconsistent: 3 };
  const raise = (id: string, s: ValidationStatus) => {
    const cur = statusById.get(id) ?? "ok";
    if (rank[s] > rank[cur]) statusById.set(id, s);
  };
  for (const f of input.fields) if (f.value === null) raise(f.id, "missing");
  for (const i of issues) {
    if (isAccepted(i)) continue;
    if (i.type === "amount_mismatch" || i.type === "tax_mismatch") {
      for (const ref of (i.detail.fields as { key: string; line: number | null }[]) ?? []) {
        const f = byRef.get(refKey(ref.key, ref.line));
        if (f && f.value !== null) raise(f.id, "inconsistent");
      }
    } else if (i.fieldId) {
      raise(i.fieldId, i.type === "conflict" ? "inconsistent" : i.type === "missing_required" ? "missing" : "needs_review");
    }
  }

  const known = isKnownType(type) ? type : null;
  const dateValue = known ? header(DATE_KEY[known])?.value ?? null : null;
  return {
    issues,
    fieldStatuses: input.fields.map((f) => ({ id: f.id, status: statusById.get(f.id) ?? "ok" })),
    checks,
    summary: {
      issuer_name: header("issuer_name")?.value ?? null,
      document_number: known ? header(NUMBER_KEY[known])?.value ?? null : null,
      issue_date: isIsoDate(dateValue) ? dateValue : null,
      total_amount: int("total_amount"),
    },
  };
}

/** 書類種別に合う項目のキー（読取結果に無い項目も、表示用に空の行を作る） */
export function headerKeysFor(type: DocumentType | null): string[] {
  return isKnownType(type) ? FIELD_DEFS[type].map((f) => f.key) : [];
}
