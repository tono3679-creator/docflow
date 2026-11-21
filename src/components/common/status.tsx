import { AlertTriangle, CheckCircle2, CircleDashed, CircleX, Loader2, MinusCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DOCUMENT_STATUS_LABEL, FIELD_STATUS_LABEL, type DocumentStatus, type ValidationStatus } from "@/lib/domain/labels";
import { DOCUMENT_TYPE_LABELS } from "@/lib/extraction/schema";
import type { DocumentType } from "@/lib/extraction/types";

const DOC_VARIANT = {
  queued: "neutral",
  processing: "info",
  needs_review: "warning",
  ready: "info",
  confirmed: "success",
  error: "danger",
  excluded: "neutral",
} as const;

/** 書類の状態（色だけに頼らず、文字とアイコンでも示す） */
export function DocumentStatusBadge({ status, issues }: { status: DocumentStatus; issues?: number }) {
  const Icon = status === "processing" ? Loader2 : status === "confirmed" ? CheckCircle2 : status === "error" ? CircleX : status === "needs_review" ? AlertTriangle : status === "excluded" ? MinusCircle : CircleDashed;
  return (
    <Badge variant={DOC_VARIANT[status]}>
      <Icon className={status === "processing" ? "animate-spin" : undefined} aria-hidden />
      {DOCUMENT_STATUS_LABEL[status]}
      {status === "needs_review" && !!issues && <span className="tabular">{issues}</span>}
    </Badge>
  );
}

const FIELD_VARIANT = { ok: "neutral", needs_review: "warning", inconsistent: "danger", missing: "neutral", confirmed: "success" } as const;

/** 項目の状態。「正常」は検証で問題を見つけていないという意味 */
export function FieldStatusBadge({ status, confirmed }: { status: ValidationStatus; confirmed: boolean }) {
  const key = confirmed && status !== "inconsistent" ? "confirmed" : status;
  return <Badge variant={FIELD_VARIANT[key]} className="px-1.5 text-[11px]">{FIELD_STATUS_LABEL[key]}</Badge>;
}

export function TypeLabel({ type }: { type: DocumentType | null }) {
  return <span>{DOCUMENT_TYPE_LABELS[type ?? "unknown"]}</span>;
}
