"use client";
/**
 * 確認事項（なぜ要確認・不整合なのか）、重複の疑い、金額の照合。
 *   - 要確認（黄）：項目を原本と見比べて「確認」を押すと解消
 *   - 不整合（赤）：値を直すか、理由を付けて承認すると解消（承認した内容と値が変わったら、もう一度確認が要る）
 *   - 重複：自動では消さない。「重複として除外」または「重複ではない」を選ぶ
 */
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleHelp, CircleX, Copy } from "lucide-react";
import { DocumentStatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DuplicateRow, IssueRow } from "@/lib/data/documents";
import type { AmountCheck } from "@/lib/validation/reconcile";
import { cn } from "@/lib/utils";

const DUP_KIND: Record<DuplicateRow["kind"], string> = {
  exact_file: "同じファイル",
  same_number: "同じ番号・発行元",
  similar: "日付と金額が同じ",
};

/** 確認を押せば解消する確認事項（不整合・未取得・重複・種別不明は、確認だけでは解消しない） */
const SOLVED_BY_CONFIRM = new Set(["low_confidence", "ambiguous", "invalid_format", "date_format", "date_order", "no_source", "unverifiable", "conflict"]);
/** 理由を付けて承認できる確認事項 */
const ACCEPTABLE = new Set(["amount_mismatch", "tax_mismatch", "missing_required", "read_failed"]);

function AcceptForm({ onAccept, busy }: { onAccept: (reason: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>理由を付けて承認</Button>;
  }
  return (
    <form
      className="mt-1.5 flex w-full gap-2"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onAccept(reason.trim());
      }}
    >
      <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="例：原本どおり（先方の計算誤り。連絡済み）" aria-label="承認の理由" className="h-8 text-xs" />
      <Button type="submit" size="sm" variant="brand" disabled={busy || !reason.trim()}>承認</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>やめる</Button>
    </form>
  );
}

export function IssuePanel({
  issues, duplicates, fieldLabel, pendingConfirm, editable, busy, onSelectField, onConfirmField, onAccept, onReopen, onDecideDuplicate,
}: {
  issues: IssueRow[];
  duplicates: DuplicateRow[];
  fieldLabel: (fieldId: string | null) => string | null;
  /** 保存前に「確認」を押した項目 */
  pendingConfirm: (fieldId: string | null) => boolean;
  editable: boolean;
  busy: boolean;
  onSelectField: (fieldId: string) => void;
  onConfirmField: (fieldId: string) => void;
  onAccept: (issueId: string, reason: string) => void;
  onReopen: (issueId: string) => void;
  onDecideDuplicate: (candidateId: string, decision: "duplicate" | "not_duplicate" | "pending") => void;
}) {
  const open = issues.filter((i) => i.status === "open" && i.issue_type !== "duplicate");
  const accepted = issues.filter((i) => i.status === "accepted");
  const pendingDups = duplicates.filter((d) => d.status === "pending");
  const decidedDups = duplicates.filter((d) => d.status !== "pending");
  if (open.length === 0 && accepted.length === 0 && duplicates.length === 0) return null;
  return (
    <div className="grid gap-3">
      {pendingDups.map((d) => (
        <div key={d.id} className="rounded-md border border-destructive/30 bg-danger-soft/50 p-3 text-sm" data-testid="duplicate-candidate">
          <div className="flex items-start gap-2">
            <Copy className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-danger-strong">重複の疑い（{DUP_KIND[d.kind]}）</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                <Link href={`/documents/${d.other_document_id}`} className="truncate text-brand hover:underline" target="_blank">{d.other_filename}</Link>
                <DocumentStatusBadge status={d.other_status} />
              </div>
            </div>
          </div>
          {editable && (
            <div className="mt-2 flex flex-wrap gap-2 pl-6">
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onDecideDuplicate(d.id, "duplicate")}>重複として除外</Button>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onDecideDuplicate(d.id, "not_duplicate")}>重複ではない</Button>
            </div>
          )}
        </div>
      ))}

      {open.length > 0 && (
        <ul className="divide-y rounded-md border bg-card" aria-label="確認事項">
          {open.map((i) => {
            const label = fieldLabel(i.field_id);
            const pending = pendingConfirm(i.field_id) && SOLVED_BY_CONFIRM.has(i.issue_type);
            const Icon = i.severity === "error" ? CircleX : AlertTriangle;
            return (
              <li
                key={i.id}
                data-issue={i.issue_type}
                className={cn("flex flex-wrap items-start gap-x-2 gap-y-1 px-3 py-2 text-sm", i.field_id && "cursor-pointer hover:bg-muted/40", pending && "opacity-60")}
                onClick={() => i.field_id && onSelectField(i.field_id)}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", i.severity === "error" ? "text-destructive" : "text-warning")} aria-label={i.severity === "error" ? "不整合" : "要確認"} />
                <div className="min-w-0 flex-1">
                  {label && <span className="mr-1.5 font-medium">{label}</span>}
                  <span className={i.severity === "error" ? "text-danger-strong" : "text-warning-strong"}>{i.reason}</span>
                  {typeof i.detail?.explanation === "string" && i.detail.explanation !== i.reason && <div className="text-xs text-muted-foreground">{i.detail.explanation}</div>}
                  {pending && <div className="text-xs text-info-strong">保存すると解消します</div>}
                </div>
                {editable && !pending && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {i.field_id && SOLVED_BY_CONFIRM.has(i.issue_type) && (
                      <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); onConfirmField(i.field_id!); }}>確認済みにする</Button>
                    )}
                  </div>
                )}
                {editable && ACCEPTABLE.has(i.issue_type) && <div className="basis-full pl-6"><AcceptForm busy={busy} onAccept={(reason) => onAccept(i.id, reason)} /></div>}
              </li>
            );
          })}
        </ul>
      )}

      {(accepted.length > 0 || decidedDups.length > 0) && (
        <details className="rounded-md border bg-card text-sm">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">承認・判断済み {accepted.length + decidedDups.length}件</summary>
          <ul className="divide-y border-t">
            {accepted.map((i) => (
              <li key={i.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                <div className="min-w-0 flex-1">
                  {fieldLabel(i.field_id) && <span className="mr-1.5 font-medium">{fieldLabel(i.field_id)}</span>}
                  {i.reason}
                  <div className="text-muted-foreground">承認の理由：{i.accept_reason}</div>
                </div>
                {editable && <button type="button" className="shrink-0 text-brand hover:underline disabled:opacity-50" disabled={busy} onClick={() => onReopen(i.id)}>取り消す</button>}
              </li>
            ))}
            {decidedDups.map((d) => (
              <li key={d.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                <div className="min-w-0 flex-1">
                  {d.status === "duplicate" ? "重複と判断" : "重複ではないと判断"}（{DUP_KIND[d.kind]}）：
                  <Link href={`/documents/${d.other_document_id}`} className="text-brand hover:underline">{d.other_filename}</Link>
                </div>
                {editable && <button type="button" className="shrink-0 text-brand hover:underline disabled:opacity-50" disabled={busy} onClick={() => onDecideDuplicate(d.id, "pending")}>取り消す</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const CHECK_META = {
  match: { label: "一致", Icon: CheckCircle2, cls: "text-success-strong" },
  mismatch: { label: "不一致", Icon: CircleX, cls: "text-danger-strong" },
  unverifiable: { label: "検証不能", Icon: CircleHelp, cls: "text-muted-foreground" },
} as const;

/** 金額の照合（計算方式が分からないときは不一致と断定せず「検証不能」） */
export function AmountChecks({ checks, onSelect }: { checks: AmountCheck[]; onSelect: (ref: { key: string; line: number | null }) => void }) {
  if (checks.length === 0) return <p className="px-4 py-3 text-xs text-muted-foreground">照合できる金額がありません。</p>;
  return (
    <ul className="divide-y divide-border/60" aria-label="金額の照合">
      {checks.map((c) => {
        const m = CHECK_META[c.status];
        return (
          <li key={c.id} data-check={c.id} data-check-status={c.status}>
            <button type="button" onClick={() => c.fields[0] && onSelect(c.fields[0])} className="flex w-full items-start gap-2 px-4 py-2 text-left text-sm hover:bg-muted/40">
              <m.Icon className={cn("mt-0.5 size-4 shrink-0", m.cls)} aria-hidden />
              <span className="min-w-0 flex-1">
                <span>{c.label}</span>
                {c.status !== "match" && <span className="block text-xs text-muted-foreground">{c.reason}</span>}
              </span>
              <span className={cn("shrink-0 text-xs font-medium", m.cls)}>{m.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
