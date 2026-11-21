"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Filter = { q: string; status: string; type: string; from: string; to: string };

const TARGETS = [
  { value: "invoice", label: "請求書" },
  { value: "receipt", label: "領収書" },
  { value: "delivery_note", label: "納品書" },
  { value: "lines", label: "明細" },
] as const;

function Choice({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={cn("rounded-md border px-3 py-2 text-left text-sm transition-colors", checked ? "border-brand bg-brand-soft font-medium text-info-strong" : "hover:bg-muted")}
    >
      {children}
    </button>
  );
}

/** 出力：Excel（種別ごとのシート＋明細）または CSV（種別を1つ）。選んだ書類か、今の絞り込み条件に合う書類 */
export function ExportDialog({ open, onOpenChange, ids, filter, total }: { open: boolean; onOpenChange: (v: boolean) => void; ids: string[]; filter: Filter; total: number }) {
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [target, setTarget] = useState<string>("invoice");
  const [confirmedOnly, setConfirmedOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const bySelection = ids.length > 0;

  const run = async () => {
    setBusy(true);
    try {
      const body = {
        format,
        target: format === "xlsx" ? "all" : target,
        ...(bySelection ? { ids } : { filter: { ...filter, status: confirmedOnly ? "confirmed" : filter.status } }),
      };
      const res = await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        toast.error(j?.error ?? "出力できませんでした");
        return;
      }
      const blob = await res.blob();
      const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `DocFlow.${format}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${res.headers.get("x-export-rows") ?? ""}行を出力しました`);
      onOpenChange(false);
    } catch {
      toast.error("通信できませんでした");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>出力</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">{bySelection ? `選んだ ${ids.length} 件` : `絞り込み条件に合う書類（${total}件）`}</p>
          <div className="grid gap-1.5">
            <Label>形式</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="形式">
              <Choice checked={format === "xlsx"} onClick={() => setFormat("xlsx")}>Excel<span className="block text-xs font-normal text-muted-foreground">種別ごとのシート＋明細</span></Choice>
              <Choice checked={format === "csv"} onClick={() => setFormat("csv")}>CSV<span className="block text-xs font-normal text-muted-foreground">UTF-8（BOM 付き）</span></Choice>
            </div>
          </div>
          {format === "csv" && (
            <div className="grid gap-1.5">
              <Label>内容</Label>
              <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="内容">
                {TARGETS.map((t) => <Choice key={t.value} checked={target === t.value} onClick={() => setTarget(t.value)}>{t.label}</Choice>)}
              </div>
            </div>
          )}
          {!bySelection && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} />
              処理済み（確定した書類）だけ
            </label>
          )}
          <p className="text-xs text-muted-foreground">DocFlow の標準の列で出力します（会計ソフト固有の形式ではありません）。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>閉じる</Button>
          <Button variant="brand" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            出力する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
