"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Filter = { q: string; status: string; type: string; from: string; to: string };
type Counts = { documents: number; invoice: number; receipt: number; delivery_note: number; lines: number };

const TARGETS = [
  { value: "invoice", label: "請求書" },
  { value: "receipt", label: "領収書" },
  { value: "delivery_note", label: "納品書" },
  { value: "lines", label: "明細" },
] as const;
const DOC_TARGETS = ["invoice", "receipt", "delivery_note"] as const;

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
  // CSV の内容。自分で選ぶまでは、対象の書類にいちばん多い種別を選んでおく（下の auto）
  const [picked, setPicked] = useState<string | null>(null);
  const [confirmedOnly, setConfirmedOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; counts: Counts } | null>(null);
  const bySelection = ids.length > 0;
  const scope = bySelection ? { ids } : { filter: { ...filter, status: confirmedOnly ? "confirmed" : filter.status } };
  const scopeKey = JSON.stringify(scope);

  // 押す前に、条件に合う件数（種別ごと）を見せる。0 件の内容は出力できないようにする（見出しだけのファイルを渡さない）
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "xlsx", target: "all", preview: true, ...JSON.parse(scopeKey) }),
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Counts | null) => j && setLoaded({ key: scopeKey, counts: j }))
      .catch(() => {});
    return () => {
      ctrl.abort();
      // 閉じたら忘れる（次に開いたときは、その間に確定した書類も数え直す）
      setLoaded(null);
    };
  }, [open, scopeKey]);
  const counts = loaded?.key === scopeKey ? loaded.counts : null;
  // 閉じたら、自分で選んだ内容も忘れる（次に別の書類を選んで開いたときは、その種別に合わせる）
  useEffect(() => {
    if (!open) return;
    return () => setPicked(null);
  }, [open]);

  // 納品書だけをチェックして開いたら「納品書」。種別が混ざっていれば件数の多い種別（同じなら請求書・領収書・納品書の順）
  const auto = counts === null ? "invoice" : DOC_TARGETS.reduce((best, t) => (counts[t] > counts[best] ? t : best));
  const target = picked ?? auto;

  const chosen = counts === null ? null : format === "csv" ? counts[target as keyof Counts] : counts.invoice + counts.receipt + counts.delivery_note;
  const targetLabel = format === "csv" ? (TARGETS.find((t) => t.value === target)?.label ?? "") : "書類";
  const countText = (t: (typeof TARGETS)[number]["value"]) => (counts === null ? "…" : t === "lines" ? `${counts.lines}行` : `${counts[t]}件`);
  // 対象に入っている種別（0 件のとき、何なら出せるかを示す）
  const present = counts === null ? "" : DOC_TARGETS.filter((t) => counts[t] > 0).map((t) => `${TARGETS.find((x) => x.value === t)?.label} ${counts[t]}件`).join("・");

  const run = async () => {
    setBusy(true);
    try {
      const body = { format, target: format === "xlsx" ? "all" : target, ...scope };
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
          <p className="text-sm text-muted-foreground" data-testid="export-scope">
            {bySelection ? `選んだ ${ids.length} 件` : `絞り込み条件に合う書類（${confirmedOnly ? `処理済み ${counts?.documents ?? "…"}件／全 ${total}件` : `${total}件`}）`}
          </p>
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
                {TARGETS.map((t) => (
                  <Choice key={t.value} checked={target === t.value} onClick={() => setPicked(t.value)}>
                    {t.label}
                    <span className="block text-xs font-normal text-muted-foreground">{countText(t.value)}</span>
                  </Choice>
                ))}
              </div>
            </div>
          )}
          {!bySelection && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} />
              処理済み（確定した書類）だけ
            </label>
          )}
          {format === "xlsx" && counts !== null && (
            <p className="text-sm text-muted-foreground">請求書 {counts.invoice}件・領収書 {counts.receipt}件・納品書 {counts.delivery_note}件・明細 {counts.lines}行</p>
          )}
          {chosen === 0 && (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-strong" role="status" data-testid="export-empty">
              {bySelection ? `選んだ書類に${targetLabel}がありません${present ? `（${present}）` : ""}。` : `${confirmedOnly ? "処理済み（確定した）" : "条件に合う"}${targetLabel}がありません。`}
              {!bySelection && confirmedOnly && "「処理済みだけ」を外すと、確認中の書類も出力できます。"}
            </p>
          )}
          <p className="text-xs text-muted-foreground">DocFlow の標準の列で出力します（会計ソフト固有の形式ではありません）。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>閉じる</Button>
          <Button variant="brand" onClick={run} disabled={busy || chosen === 0}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            出力する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
