"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, RotateCw } from "lucide-react";
import { DocumentStatusBadge, TypeLabel } from "@/components/common/status";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { reprocessMany } from "@/lib/actions/documents";
import { safeAction } from "@/lib/client/safe-action";
import type { DocumentListRow } from "@/lib/data/documents";
import { formatDate, formatDateTimeFull, formatYen } from "@/lib/format";
import { ExportDialog } from "./export-dialog";

type Filter = { q: string; status: string; type: string; from: string; to: string };

export function DocumentTable({ rows, total, filter, canExport, canReprocess }: { rows: DocumentListRow[]; total: number; filter: Filter; canExport: boolean; canReprocess: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const ids = [...selected];

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="text-sm text-muted-foreground">{selected.size > 0 ? `${selected.size}件を選択` : `${total}件`}</span>
        <div className="ml-auto flex gap-2">
          {canReprocess && selected.size > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => startTransition(async () => {
                const r = await safeAction(() => reprocessMany(ids));
                if (!r.ok) toast.error(r.error);
                else {
                  toast.success(`${r.data?.count ?? 0}件を読み直します${r.data?.failed ? `（${r.data.failed}件は対象外）` : ""}`);
                  setSelected(new Set());
                  router.refresh();
                }
              })}
            >
              <RotateCw aria-hidden />読み直し
            </Button>
          )}
          {canExport && (
            <Button size="sm" variant={selected.size > 0 ? "brand" : "outline"} onClick={() => setExportOpen(true)} disabled={total === 0}>
              <Download aria-hidden />出力
            </Button>
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="該当する書類はありません" />
      ) : (
        <>
          {/* PC：表 */}
          <table className="hidden w-full text-sm md:table">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-10 py-2.5 pl-4">
                  <input type="checkbox" className="size-4 accent-[var(--brand)]" aria-label="すべて選択" checked={allChecked}
                    onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} />
                </th>
                <th className="py-2.5 font-medium">状態</th>
                <th className="py-2.5 font-medium">種別</th>
                <th className="py-2.5 font-medium">発行元</th>
                <th className="py-2.5 font-medium">番号</th>
                <th className="py-2.5 font-medium">発行日</th>
                <th className="py-2.5 pr-4 text-right font-medium">合計</th>
                <th className="py-2.5 pr-4 font-medium">登録</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((d) => (
                <tr key={d.id} className="group hover:bg-muted/40">
                  <td className="py-2.5 pl-4">
                    <input type="checkbox" className="size-4 accent-[var(--brand)]" aria-label={`${d.filename} を選択`} checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                  </td>
                  <td className="py-2.5"><DocumentStatusBadge status={d.status} issues={d.open_issue_count} /></td>
                  <td className="py-2.5 whitespace-nowrap"><TypeLabel type={d.document_type} /></td>
                  <td className="max-w-72 py-2.5">
                    <Link href={`/documents/${d.id}`} className="block truncate font-medium group-hover:text-brand">{d.issuer_name ?? <span className="text-muted-foreground">{d.filename}</span>}</Link>
                    {d.issuer_name && <span className="block truncate text-xs text-muted-foreground">{d.filename}</span>}
                  </td>
                  <td className="py-2.5 text-muted-foreground">{d.document_number ?? "—"}</td>
                  <td className="tabular py-2.5 whitespace-nowrap">{d.issue_date ? formatDate(d.issue_date) : "—"}</td>
                  <td className="tabular py-2.5 pr-4 text-right whitespace-nowrap">{d.total_amount !== null ? formatYen(d.total_amount) : "—"}</td>
                  <td className="tabular py-2.5 pr-4 text-xs whitespace-nowrap text-muted-foreground">{formatDateTimeFull(d.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* スマートフォン：カード */}
          <ul className="divide-y md:hidden">
            {rows.map((d) => (
              <li key={d.id} className="flex items-start gap-3 px-4 py-3">
                <input type="checkbox" className="mt-1 size-4 accent-[var(--brand)]" aria-label={`${d.filename} を選択`} checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                <Link href={`/documents/${d.id}`} className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{d.issuer_name ?? d.filename}</span>
                    <DocumentStatusBadge status={d.status} issues={d.open_issue_count} />
                  </div>
                  <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
                    <TypeLabel type={d.document_type} />
                    <span className="tabular">{d.issue_date ? formatDate(d.issue_date) : ""}</span>
                    <span className="tabular ml-auto text-foreground">{d.total_amount !== null ? formatYen(d.total_amount) : ""}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {canExport && <ExportDialog open={exportOpen} onOpenChange={setExportOpen} ids={ids} filter={filter} total={total} />}
    </div>
  );
}
