/** 検証（確認事項・項目の状態）、重複の候補、確認画面の変更の組み立て */
import { describe, expect, it } from "vitest";
import { buildChanges, effectiveConfirmed, noBoxNotice, toneOf, type ReviewField } from "@/components/review/model";
import { findDuplicates, type DupDoc } from "@/lib/validation/duplicates";
import { validateDocument, type FieldState, type ValidateInput } from "@/lib/validation/validate";

const ctx = { textFound: true, taxIncluded: null, rounding: null, statedRates: ["10" as const], hasReducedMarker: false };

function f(key: string, value: string | null, over: Partial<FieldState> = {}): FieldState {
  return { id: over.id ?? key, key, line: null, value, hasSource: true, conf: null, source: "pdf_text", reviewStatus: "unreviewed", ...over };
}

function input(fields: FieldState[], over: Partial<ValidateInput> = {}): ValidateInput {
  return { documentType: "invoice", fields, conflicts: {}, context: ctx, threshold: 0.8, duplicates: [], accepted: {}, ...over };
}

const invoice = (over: Record<string, Partial<FieldState> & { value?: string | null }> = {}) => {
  const values: Record<string, string | null> = {
    issuer_name: "株式会社テスト", recipient_name: "株式会社山田商事", invoice_number: "INV-1", issue_date: "2026-11-01",
    subtotal: "10000", tax_amount: "1000", total_amount: "11000",
  };
  return Object.entries(values).map(([k, v]) => f(k, over[k]?.value !== undefined ? over[k].value! : v, over[k]));
};

const statusOf = (r: ReturnType<typeof validateDocument>, id: string) => r.fieldStatuses.find((s) => s.id === id)?.status;

describe("validateDocument", () => {
  it("問題のない請求書は確認事項なし・すべて正常", () => {
    const r = validateDocument(input(invoice()));
    expect(r.issues).toEqual([]);
    expect(r.fieldStatuses.every((s) => s.status === "ok")).toBe(true);
    expect(r.summary).toEqual({ issuer_name: "株式会社テスト", document_number: "INV-1", issue_date: "2026-11-01", total_amount: 11000 });
  });

  it("OCR の信頼度が低い項目は要確認。確認済みにすると解消する", () => {
    const low = validateDocument(input(invoice({ total_amount: { conf: 0.42, source: "ocr" } })));
    expect(low.issues.map((i) => i.type)).toContain("low_confidence");
    expect(statusOf(low, "total_amount")).toBe("needs_review");
    const done = validateDocument(input(invoice({ total_amount: { conf: 0.42, source: "ocr", reviewStatus: "confirmed" } })));
    expect(done.issues).toEqual([]);
  });

  it("原本の位置が分からない項目は要確認（架空の位置に印を出さない代わりに知らせる）", () => {
    const r = validateDocument(input(invoice({ issuer_name: { hasSource: false } })));
    expect(r.issues.find((i) => i.type === "no_source")?.fieldId).toBe("issuer_name");
  });

  it("必須項目が未取得なら不整合の確認事項・項目は未取得", () => {
    const r = validateDocument(input(invoice({ issue_date: { value: null } })));
    const i = r.issues.find((x) => x.type === "missing_required");
    expect(i?.severity).toBe("error");
    expect(statusOf(r, "issue_date")).toBe("missing");
  });

  it("合計が合わなければ、関係する項目を不整合（赤）にする。理由を付けて承認すると赤を外す", () => {
    const bad = validateDocument(input(invoice({ total_amount: { value: "12000" } })));
    const issue = bad.issues.find((i) => i.type === "amount_mismatch")!;
    expect(issue).toBeTruthy();
    expect(statusOf(bad, "total_amount")).toBe("inconsistent");
    const accepted = validateDocument(input(invoice({ total_amount: { value: "12000" } }), { accepted: { [issue.key]: issue.detail.sig as string } }));
    expect(statusOf(accepted, "total_amount")).toBe("ok");
    // 承認したあとに値が変わった（sig が違う）なら、また赤
    const changed = validateDocument(input(invoice({ total_amount: { value: "12500" } }), { accepted: { [issue.key]: issue.detail.sig as string } }));
    expect(statusOf(changed, "total_amount")).toBe("inconsistent");
  });

  it("日付の形式が不明・支払期限が発行日より前", () => {
    const r = validateDocument(input([...invoice({ issue_date: { value: "2026/13/45" } })]));
    expect(r.issues.some((i) => i.type === "date_format")).toBe(true);
    const r2 = validateDocument(input([...invoice(), f("due_date", "2026-10-01")]));
    expect(r2.issues.some((i) => i.type === "date_order")).toBe(true);
  });

  it("読取で見つかった別の記載（矛盾）は不整合", () => {
    const r = validateDocument(input(invoice(), { conflicts: { issuer_name: ["株式会社テスト", "テスト商会"] } }));
    expect(r.issues.find((i) => i.type === "conflict")?.reason).toContain("テスト商会");
    expect(statusOf(r, "issuer_name")).toBe("inconsistent");
  });

  it("書類種別が不明・文字を読み取れない", () => {
    const r = validateDocument(input([], { documentType: "unknown", context: { ...ctx, textFound: false } }));
    expect(r.issues.map((i) => i.type).sort()).toEqual(["read_failed", "type_unknown"]);
  });

  it("利用者が入力した値は、信頼度・原本の位置の確認をしない", () => {
    const r = validateDocument(input(invoice({ total_amount: { source: "user", hasSource: false, conf: null } })));
    expect(r.issues).toEqual([]);
  });
});

describe("findDuplicates（自動では消さず、候補を示す）", () => {
  const doc = (id: string, over: Partial<DupDoc> = {}): DupDoc => ({
    id, fileHash: `h-${id}`, documentType: "invoice", issuerName: "株式会社テスト", documentNumber: `N-${id}`, issueDate: "2026-11-01",
    totalAmount: 1000 + Number(id), uploadedAt: `2026-11-0${id}T00:00:00Z`, filename: `${id}.pdf`, ...over,
  });
  it("同じファイル", () => {
    expect(findDuplicates(doc("2", { fileHash: "same" }), [doc("1", { fileHash: "same" })])[0].kind).toBe("exact_file");
  });
  it("同じ番号（発行元の表記ゆれ「㈱」を同じとみなす）", () => {
    expect(findDuplicates(doc("2", { documentNumber: "INV-9" }), [doc("1", { documentNumber: "INV-9", issuerName: "㈱テスト" })])[0].kind).toBe("same_number");
  });
  it("発行元・日付・合計が同じ", () => {
    expect(findDuplicates(doc("2", { totalAmount: 5000 }), [doc("1", { totalAmount: 5000 })])[0].kind).toBe("similar");
  });
  it("後から登録した書類にだけ印を付ける・種別が違えば重複にしない", () => {
    expect(findDuplicates(doc("1", { fileHash: "same" }), [doc("2", { fileHash: "same" })])).toEqual([]);
    expect(findDuplicates(doc("2", { documentNumber: "X" }), [doc("1", { documentNumber: "X", documentType: "receipt" })])).toEqual([]);
  });
});

describe("確認画面の変更の組み立て", () => {
  const rf = (id: string, over: Partial<ReviewField> = {}): ReviewField => ({
    id, field_key: "total_amount", line_index: null, extracted_value: "11000", value: "11000", page_number: 1,
    bounding_box: { x: 0.1, y: 0.1, w: 0.1, h: 0.02 }, confidence: 0.5, source: "ocr", validation_status: "needs_review", review_status: "unreviewed", ...over,
  });
  it("値を直しただけでは確認済みにしない", () => {
    const changes = buildChanges("invoice", [rf("a")], { values: { a: "12,000" }, confirms: {} });
    expect(changes).toEqual([{ op: "set", fieldId: "a", value: "12,000" }]);
  });
  it("書き方だけの違い（11,000 と 11000）は変更にしない", () => {
    expect(buildChanges("invoice", [rf("a")], { values: { a: "11,000" }, confirms: {} })).toEqual([]);
  });
  it("確認を押したときだけ確認済みにする。確認済みの項目の値を直すと未確認に戻る", () => {
    expect(buildChanges("invoice", [rf("a")], { values: {}, confirms: { a: true } })).toEqual([{ op: "set", fieldId: "a", confirm: true }]);
    const confirmed = rf("b", { review_status: "confirmed" });
    expect(effectiveConfirmed("invoice", confirmed, { values: { b: "999" }, confirms: {} })).toBe(false);
    expect(buildChanges("invoice", [confirmed], { values: {}, confirms: { b: false } })).toEqual([{ op: "set", fieldId: "b", unconfirm: true }]);
  });
  it("空にした値は null で送る", () => {
    expect(buildChanges("invoice", [rf("a")], { values: { a: "  " }, confirms: {} })).toEqual([{ op: "set", fieldId: "a", value: null }]);
  });
  it("原本の印の色：赤＝不整合、黄＝要確認、確認済みは選んだときだけ緑", () => {
    expect(toneOf({ validation_status: "inconsistent" }, true, false)).toBe("danger");
    expect(toneOf({ validation_status: "needs_review" }, false, false)).toBe("warning");
    expect(toneOf({ validation_status: "needs_review" }, true, false)).toBe("none");
    expect(toneOf({ validation_status: "ok" }, true, true)).toBe("confirmed");
  });
  it("原本の位置が分からない項目は、印を出さずに理由を示す", () => {
    expect(noBoxNotice("invoice", rf("a", { bounding_box: null }))).toContain("特定できない");
    expect(noBoxNotice("invoice", rf("a", { value: null, bounding_box: null }))).toContain("読み取れていません");
    expect(noBoxNotice("invoice", rf("a"))).toBeNull();
  });
});
