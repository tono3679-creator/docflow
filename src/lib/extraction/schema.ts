/**
 * 書類種別ごとの項目の定義（画面・読取・検証・出力で共通に使う）。
 *   show: "always"     … 値が無くても欄を表示する（未取得として示す）
 *         "if_present" … 値があるときだけ表示する（税率ごとの内訳など。画面を詰め込みすぎない）
 */
import type { DocumentType } from "./types";

export type FieldKind = "text" | "company" | "date" | "amount" | "code" | "reg_no" | "multiline" | "payment";
export type LineKind = "text" | "quantity" | "unit" | "unit_price" | "amount" | "tax_rate";

export type FieldDef = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  show: "always" | "if_present";
};

export type LineFieldDef = { key: string; label: string; kind: LineKind };

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  invoice: "請求書",
  receipt: "領収書",
  delivery_note: "納品書",
  unknown: "不明",
};

export const KNOWN_TYPES = ["invoice", "receipt", "delivery_note"] as const;
export type KnownType = (typeof KNOWN_TYPES)[number];

const tax = (): FieldDef[] => [
  { key: "tax_10_base", label: "10%対象", kind: "amount", required: false, show: "if_present" },
  { key: "tax_10", label: "消費税10%", kind: "amount", required: false, show: "if_present" },
  { key: "tax_8_base", label: "8%対象", kind: "amount", required: false, show: "if_present" },
  { key: "tax_8", label: "消費税8%", kind: "amount", required: false, show: "if_present" },
];

export const FIELD_DEFS: Record<KnownType, FieldDef[]> = {
  invoice: [
    { key: "issuer_name", label: "発行元", kind: "company", required: true, show: "always" },
    { key: "recipient_name", label: "請求先", kind: "company", required: true, show: "always" },
    { key: "invoice_number", label: "請求番号", kind: "code", required: true, show: "always" },
    { key: "issue_date", label: "発行日", kind: "date", required: true, show: "always" },
    { key: "due_date", label: "支払期限", kind: "date", required: false, show: "always" },
    { key: "registration_number", label: "登録番号", kind: "reg_no", required: false, show: "always" },
    { key: "subtotal", label: "小計", kind: "amount", required: false, show: "always" },
    { key: "discount", label: "値引き", kind: "amount", required: false, show: "if_present" },
    { key: "shipping_fee", label: "送料・手数料", kind: "amount", required: false, show: "if_present" },
    ...tax(),
    { key: "tax_amount", label: "消費税", kind: "amount", required: false, show: "always" },
    { key: "total_amount", label: "合計", kind: "amount", required: true, show: "always" },
    { key: "notes", label: "備考", kind: "multiline", required: false, show: "always" },
  ],
  receipt: [
    { key: "issuer_name", label: "発行元", kind: "company", required: true, show: "always" },
    { key: "recipient_name", label: "宛名", kind: "company", required: false, show: "always" },
    { key: "receipt_number", label: "領収書番号", kind: "code", required: false, show: "if_present" },
    { key: "issue_date", label: "発行日", kind: "date", required: true, show: "always" },
    { key: "total_amount", label: "領収金額", kind: "amount", required: true, show: "always" },
    ...tax(),
    { key: "tax_amount", label: "消費税", kind: "amount", required: false, show: "always" },
    { key: "payment_method", label: "支払方法", kind: "payment", required: false, show: "always" },
    { key: "registration_number", label: "登録番号", kind: "reg_no", required: false, show: "always" },
    { key: "purpose", label: "但し書き", kind: "text", required: false, show: "always" },
  ],
  delivery_note: [
    { key: "issuer_name", label: "発行元", kind: "company", required: true, show: "always" },
    { key: "recipient_name", label: "納品先", kind: "company", required: true, show: "always" },
    { key: "delivery_number", label: "納品書番号", kind: "code", required: false, show: "always" },
    { key: "delivery_date", label: "納品日", kind: "date", required: true, show: "always" },
    { key: "subtotal", label: "小計", kind: "amount", required: false, show: "if_present" },
    ...tax(),
    { key: "tax_amount", label: "消費税", kind: "amount", required: false, show: "if_present" },
    { key: "total_amount", label: "合計", kind: "amount", required: false, show: "always" },
    { key: "notes", label: "備考", kind: "multiline", required: false, show: "always" },
  ],
};

export const LINE_FIELDS: LineFieldDef[] = [
  { key: "description", label: "品名", kind: "text" },
  { key: "quantity", label: "数量", kind: "quantity" },
  { key: "unit", label: "単位", kind: "unit" },
  { key: "unit_price", label: "単価", kind: "unit_price" },
  { key: "amount", label: "金額", kind: "amount" },
  { key: "tax_rate", label: "税率", kind: "tax_rate" },
];
export const LINE_KEYS = LINE_FIELDS.map((f) => f.key);

/** 書類番号の項目（一覧・重複判定に使う） */
export const NUMBER_KEY: Record<KnownType, string> = {
  invoice: "invoice_number",
  receipt: "receipt_number",
  delivery_note: "delivery_number",
};
/** 日付の代表（一覧・期間の絞り込みに使う） */
export const DATE_KEY: Record<KnownType, string> = {
  invoice: "issue_date",
  receipt: "issue_date",
  delivery_note: "delivery_date",
};

export function isKnownType(t: string | null | undefined): t is KnownType {
  return t === "invoice" || t === "receipt" || t === "delivery_note";
}

export function fieldDef(type: DocumentType | null | undefined, key: string): FieldDef | undefined {
  return isKnownType(type) ? FIELD_DEFS[type].find((f) => f.key === key) : undefined;
}

export function lineFieldDef(key: string): LineFieldDef | undefined {
  return LINE_FIELDS.find((f) => f.key === key);
}

export const TAX_RATE_LABELS: Record<string, string> = { "10": "10%", "8": "8%", "0": "非課税・対象外" };
