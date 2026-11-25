/**
 * 重複書類の候補。自動では削除しない（利用者が確認して判断する）。
 *   exact_file  … ファイルの SHA-256 が同じ
 *   same_number … 書類種別・番号が同じ（発行元が分かっていれば発行元も同じ）
 *   similar     … 書類種別・発行元・日付・合計金額が同じ
 * 比べるのは、この書類より前に登録された書類だけ（後から来た方に印を付ける）。
 */
import { compactKey } from "../extraction/text";

export type DupDoc = {
  id: string;
  fileHash: string;
  documentType: string | null;
  issuerName: string | null;
  documentNumber: string | null;
  issueDate: string | null;
  totalAmount: number | null;
  uploadedAt: string;
  filename: string;
};

export type DupMatch = { otherId: string; kind: "exact_file" | "same_number" | "similar"; matched: Record<string, string | number> };

/** 発行元の比較用（「株式会社」「(株)」「㈱」などの書き方の違いを除く。compactKey は括弧を消すので、その前に除く） */
const issuerKey = (s: string | null) => (s ? compactKey(s.normalize("NFKC").replace(/株式会社|有限会社|合同会社|[(（]\s*[株有同]\s*[)）]/g, "")) : "");

export function findDuplicates(target: DupDoc, others: DupDoc[]): DupMatch[] {
  const out: DupMatch[] = [];
  for (const o of others) {
    if (o.id === target.id) continue;
    if (o.uploadedAt > target.uploadedAt || (o.uploadedAt === target.uploadedAt && o.id > target.id)) continue;
    if (o.fileHash === target.fileHash) {
      out.push({ otherId: o.id, kind: "exact_file", matched: { filename: o.filename } });
      continue;
    }
    if (!target.documentType || target.documentType === "unknown" || o.documentType !== target.documentType) continue;
    const sameIssuer = !!target.issuerName && !!o.issuerName && issuerKey(target.issuerName) === issuerKey(o.issuerName);
    const issuerUnknown = !target.issuerName || !o.issuerName;
    if (target.documentNumber && o.documentNumber && compactKey(target.documentNumber) === compactKey(o.documentNumber) && (sameIssuer || issuerUnknown)) {
      out.push({ otherId: o.id, kind: "same_number", matched: { document_number: target.documentNumber } });
      continue;
    }
    if (sameIssuer && target.issueDate && target.issueDate === o.issueDate && target.totalAmount !== null && target.totalAmount === o.totalAmount) {
      out.push({ otherId: o.id, kind: "similar", matched: { issue_date: target.issueDate, total_amount: target.totalAmount } });
    }
  }
  return out;
}

export const DUPLICATE_REASON: Record<DupMatch["kind"], string> = {
  exact_file: "同じファイルが登録されています",
  same_number: "同じ番号の書類が登録されています",
  similar: "発行元・日付・金額が同じ書類があります",
};
