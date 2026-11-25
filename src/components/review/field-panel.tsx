"use client";
/**
 * 項目と明細の入力。行を押す（入力欄に入る）と原本の位置を示し、原本の印を押すとこの行を選ぶ。
 * 状態は文字（正常・要確認・不整合・確認済み・未取得）と左の線の色で示す（色だけに頼らない）。
 */
import { Check, MapPin, Plus, Trash2 } from "lucide-react";
import { FieldStatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { IssueRow } from "@/lib/data/documents";
import { displayValue, editableValue } from "@/lib/extraction/normalize";
import { fieldDef } from "@/lib/extraction/schema";
import type { DocumentType } from "@/lib/extraction/types";
import { cn } from "@/lib/utils";
import { effectiveConfirmed, isValueEdited, kindOf, labelOf, LINE_COLUMNS, type Draft, type LineGroup, type ReviewField } from "./model";

/** 閲覧のみ（確定済み・閲覧者）のときも読みやすく。押せば原本の位置を示す */
const READ_ONLY = "read-only:border-transparent read-only:bg-muted/50 read-only:text-foreground read-only:shadow-none";

const SOURCE_LABEL: Record<ReviewField["source"], string> = { pdf_text: "PDF の文字", ocr: "OCR", user: "手入力" };

function edgeClass(status: ReviewField["validation_status"], confirmed: boolean) {
  if (status === "inconsistent") return "border-l-destructive";
  if (confirmed) return "border-l-success";
  if (status === "needs_review") return "border-l-warning";
  return "border-l-transparent";
}

export function ConfirmToggle({ pressed, onClick, label, disabled, compact }: { pressed: boolean; onClick: () => void; label: string; disabled?: boolean; compact?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={pressed ? `${label}の確認を取り消す` : `${label}を確認済みにする`}
      title={pressed ? "確認を取り消す" : "原本と見比べて正しければ押す"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border text-xs font-medium transition-colors disabled:opacity-50",
        compact ? "w-7 justify-center" : "px-2",
        pressed ? "border-success/60 bg-success-soft text-success-strong" : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Check className="size-3.5" aria-hidden />
      {!compact && "確認"}
    </button>
  );
}

type RowProps = {
  type: DocumentType | null;
  f: ReviewField;
  draft: Draft;
  selected: boolean;
  issues: IssueRow[];
  editable: boolean;
  onChange: (id: string, value: string) => void;
  onToggleConfirm: (ids: string[], value: boolean) => void;
  onSelect: (id: string) => void;
  onLocate: (id: string) => void;
};

function FieldRow({ type, f, draft, selected, issues, editable, onChange, onToggleConfirm, onSelect, onLocate }: RowProps) {
  const kind = kindOf(type, f);
  const def = fieldDef(type, f.field_key);
  const label = labelOf(type, f);
  const value = draft.values[f.id] ?? editableValue(kind, f.value);
  const confirmed = effectiveConfirmed(type, f, draft);
  const edited = isValueEdited(type, f, draft);
  const extractedDiffers = f.extracted_value !== null && f.extracted_value !== f.value;
  const inputProps = {
    id: `in-${f.id}`,
    value,
    readOnly: !editable,
    onFocus: () => onSelect(f.id),
    "aria-invalid": f.validation_status === "inconsistent" || undefined,
    "aria-describedby": `note-${f.id}`,
  };
  return (
    <div
      id={`field-${f.id}`}
      data-field={f.field_key}
      data-status={f.validation_status}
      onClick={() => onSelect(f.id)}
      className={cn("grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 border-l-2 px-4 py-2 transition-colors sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]", edgeClass(f.validation_status, confirmed), selected ? "bg-brand-soft/70" : "hover:bg-muted/40")}
    >
      <label htmlFor={`in-${f.id}`} className="pt-2 text-xs text-muted-foreground">
        {label}
        {def?.required && <span className="ml-0.5 text-destructive" aria-label="必須">*</span>}
      </label>
      <div className="min-w-0">
        {kind === "multiline" ? (
          <Textarea {...inputProps} rows={2} className={cn("min-h-8 py-1.5 text-sm", READ_ONLY)} onChange={(e) => onChange(f.id, e.target.value)} />
        ) : (
          <Input {...inputProps} className={cn("h-8 text-sm", READ_ONLY, (kind === "amount" || kind === "date") && "tabular")} inputMode={kind === "amount" ? "numeric" : undefined} onChange={(e) => onChange(f.id, e.target.value)} />
        )}
        <div id={`note-${f.id}`} className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground empty:hidden">
          {issues.map((i) => (
            <span key={i.id} className={i.status === "accepted" ? "text-muted-foreground line-through decoration-muted-foreground/50" : i.severity === "error" ? "text-danger-strong" : "text-warning-strong"}>
              {i.reason}
            </span>
          ))}
          {extractedDiffers && <span>読取値：{displayValue(kind, f.extracted_value)}</span>}
          {f.value !== null && f.source === "user" && <span>{SOURCE_LABEL.user}</span>}
          {edited && <span className="font-medium text-info-strong">未保存</span>}
        </div>
      </div>
      <div className="col-start-2 mt-1 flex items-center gap-1.5 sm:col-start-3 sm:mt-0 sm:pt-1">
        <FieldStatusBadge status={f.validation_status} confirmed={confirmed} />
        {editable && f.value !== null && <ConfirmToggle pressed={confirmed} label={label} onClick={() => onToggleConfirm([f.id], !confirmed)} />}
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted lg:hidden"
          aria-label={`${label}を原本で見る`}
          onClick={(e) => {
            e.stopPropagation();
            onLocate(f.id);
          }}
        >
          <MapPin className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function HeaderFields(props: Omit<RowProps, "f" | "selected" | "issues"> & { fields: ReviewField[]; selectedId: string | null; issuesByField: Map<string, IssueRow[]> }) {
  const { fields, selectedId, issuesByField, ...rest } = props;
  return (
    <div className="divide-y divide-border/60">
      {fields.map((f) => <FieldRow key={f.id} {...rest} f={f} selected={selectedId === f.id} issues={issuesByField.get(f.id) ?? []} />)}
    </div>
  );
}

function cellClass(f: ReviewField, confirmed: boolean) {
  if (f.validation_status === "inconsistent") return "border-destructive bg-danger-soft/60";
  if (!confirmed && f.validation_status === "needs_review") return "border-warning bg-warning-soft/60";
  if (confirmed) return "border-success/50";
  return "";
}

export function LineItems({
  type, groups, draft, selectedId, editable, issuesByField, onChange, onToggleConfirm, onSelect, onLocate, onAdd, onRemove, busy,
}: Omit<RowProps, "f" | "selected" | "issues"> & {
  groups: LineGroup[];
  selectedId: string | null;
  issuesByField: Map<string, IssueRow[]>;
  onAdd: () => void;
  onRemove: (line: number) => void;
  busy: boolean;
}) {
  return (
    <div>
      {groups.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">明細は読み取れていません。</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[600px] text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="w-8 py-1.5 pl-4 font-normal">#</th>
                {LINE_COLUMNS.map((c) => (
                  <th key={c.key} scope="col" className={cn("px-1 py-1.5 font-normal", c.key === "description" ? "w-auto" : c.key === "unit" || c.key === "tax_rate" ? "w-14" : "w-[5.5rem]")}>{c.label}</th>
                ))}
                <th scope="col" className="w-20 py-1.5 pr-4 font-normal"><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, n) => {
                const cells = Object.values(g.cells).filter((c): c is ReviewField => !!c);
                const lineConfirmed = cells.length > 0 && cells.every((c) => c.value === null || effectiveConfirmed(type, c, draft));
                const rowSelected = cells.some((c) => c.id === selectedId);
                return (
                  <tr key={g.line} id={`line-${g.line}`} className={cn("border-b border-border/60 align-top", rowSelected && "bg-brand-soft/70")}>
                    <td className="py-1.5 pl-4 text-muted-foreground tabular">
                      <div className="pt-1.5">{n + 1}</div>
                    </td>
                    {LINE_COLUMNS.map((c) => {
                      const f = g.cells[c.key];
                      if (!f) return <td key={c.key} className="px-1 py-1.5 text-muted-foreground">—</td>;
                      const kind = kindOf(type, f);
                      const confirmed = effectiveConfirmed(type, f, draft);
                      const reasons = (issuesByField.get(f.id) ?? []).filter((i) => i.status === "open").map((i) => i.reason);
                      return (
                        <td key={c.key} id={`field-${f.id}`} className="px-1 py-1.5">
                          <Input
                            value={draft.values[f.id] ?? editableValue(kind, f.value)}
                            readOnly={!editable}
                            aria-label={labelOf(type, f)}
                            aria-invalid={f.validation_status === "inconsistent" || undefined}
                            title={reasons.join("・") || undefined}
                            onFocus={() => onSelect(f.id)}
                            onChange={(e) => onChange(f.id, e.target.value)}
                            className={cn("h-8 px-2 text-xs", READ_ONLY, kind !== "text" && "tabular text-right", selectedId === f.id && "ring-2 ring-brand/40", cellClass(f, confirmed), isValueEdited(type, f, draft) && "font-medium text-info-strong")}
                          />
                        </td>
                      );
                    })}
                    <td className="py-1.5 pr-4">
                      <div className="flex items-center justify-end gap-1">
                        {editable && <ConfirmToggle compact pressed={lineConfirmed} label={`明細${n + 1}`} onClick={() => onToggleConfirm(cells.filter((c) => c.value !== null).map((c) => c.id), !lineConfirmed)} />}
                        <button type="button" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted lg:hidden" aria-label={`明細${n + 1}を原本で見る`} onClick={() => cells[0] && onLocate(cells[0].id)}>
                          <MapPin className="size-4" aria-hidden />
                        </button>
                        {editable && (
                          <button type="button" disabled={busy} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-danger-soft hover:text-destructive disabled:opacity-50" aria-label={`明細${n + 1}を削除`} onClick={() => onRemove(g.line)}>
                            <Trash2 className="size-3.5" aria-hidden />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <div className="px-4 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={onAdd} disabled={busy}><Plus aria-hidden />行を追加</Button>
        </div>
      )}
    </div>
  );
}
