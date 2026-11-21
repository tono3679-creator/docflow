"use client";
/**
 * 確認画面。PC は左 55%：原本／右 45%：確認事項・項目・明細・金額の照合、下に「前の書類・次の要確認・保存・確定」。
 * スマートフォン・タブレットは「原本」「項目」のタブで切り替える。
 *   - 項目を選ぶと原本の位置へ移動して青枠で示し、原本の印を押すとその項目を選ぶ
 *   - 値の修正・確認の切り替えは「保存」でまとめて保存（Ctrl+S でも保存）。値を直しただけでは確認済みにしない
 *   - 確定は、確認事項が残っていない書類だけ（DB の関数が最終的に判断する）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ChevronLeft, Download, EllipsisVertical, Loader2, RefreshCw, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { DocumentStatusBadge } from "@/components/common/status";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { confirmDocument, decideDuplicate, deleteDocument, reopenDocument, reprocessDocument, saveReview, setExcluded, type ReviewChange } from "@/lib/actions/documents";
import { safeAction } from "@/lib/client/safe-action";
import type { DocumentDetail, HistoryRow } from "@/lib/data/documents";
import { can, type OrgRole } from "@/lib/domain/labels";
import { DOCUMENT_TYPE_LABELS, KNOWN_TYPES, isKnownType, type KnownType } from "@/lib/extraction/schema";
import { formatDateTimeFull, formatYen } from "@/lib/format";
import type { AmountCheck } from "@/lib/validation/reconcile";
import { cn } from "@/lib/utils";
import { ExtractionInfo, HistoryList } from "./doc-info";
import { DocumentViewer, type Highlight } from "./document-viewer";
import { HeaderFields, LineItems } from "./field-panel";
import { AmountChecks, IssuePanel } from "./issue-panel";
import { buildChanges, effectiveConfirmed, EMPTY_DRAFT, headerFields, labelOf, lineGroups, methodLabel, noBoxNotice, toneOf, type Draft, type ReviewField } from "./model";

export type ReviewScreenProps = {
  detail: DocumentDetail;
  nav: { prev: string | null; nextReview: string | null };
  history: HistoryRow[];
  checks: AmountCheck[];
  role: OrgRole;
  staffConfirmLimit: number | null;
};

type Busy = null | "save" | "confirm" | "other";

function Section({ title, count, action, children, id }: { title: string; count?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="border-b" aria-labelledby={id}>
      <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        {count}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function ReviewScreen({ detail, nav, history, checks, role, staffConfirmLimit }: ReviewScreenProps) {
  const router = useRouter();
  const { doc, fields: rawFields, issues, duplicates, lineItems, pages, result } = detail;
  const fields = rawFields as ReviewField[];
  const type = doc.document_type;
  const canReview = can.review(role);
  const editable = canReview && (doc.status === "needs_review" || doc.status === "ready" || doc.status === "error");
  const working = doc.status === "queued" || doc.status === "processing";

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showConfirmed, setShowConfirmed] = useState(false);
  const [tab, setTab] = useState<"original" | "fields">("fields");
  const [busy, setBusy] = useState<Busy>(null);
  const [dialog, setDialog] = useState<null | { kind: "type"; type: KnownType } | { kind: "reopen" } | { kind: "exclude" } | { kind: "delete" } | { kind: "remove_line"; line: number }>(null);
  const [reason, setReason] = useState("");
  const versionRef = useRef(doc.version);
  const scrollToField = useRef<string | null>(null);

  useEffect(() => {
    versionRef.current = Math.max(versionRef.current, doc.version);
  }, [doc.version]);

  // ---- 計算 ----
  const head = useMemo(() => headerFields(type, fields), [type, fields]);
  const groups = useMemo(() => lineGroups(fields), [fields]);
  const changes = useMemo(() => buildChanges(type, fields, draft), [type, fields, draft]);
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const issuesByField = useMemo(() => {
    const m = new Map<string, typeof issues>();
    for (const i of issues) {
      if (!i.field_id) continue;
      m.set(i.field_id, [...(m.get(i.field_id) ?? []), i]);
    }
    return m;
  }, [issues]);
  const openCount = issues.filter((i) => i.status === "open").length;

  const highlights = useMemo<Highlight[]>(() => fields.flatMap((f) => {
    if (!f.bounding_box || f.page_number === null) return [];
    return [{ id: f.id, page: f.page_number, box: f.bounding_box, tone: toneOf(f, effectiveConfirmed(type, f, draft), showConfirmed), label: labelOf(type, f) }];
  }), [fields, type, draft, showConfirmed]);

  const selectedField = selectedId ? fieldById.get(selectedId) ?? null : null;
  const selected = useMemo(() => {
    if (!selectedField) return null;
    const row = selectedField.line_index !== null ? lineItems.find((l) => l.line_index === selectedField.line_index) : null;
    return {
      id: selectedField.id,
      page: selectedField.page_number,
      box: selectedField.bounding_box,
      rowBox: row?.bounding_box && row.page_number !== null ? { page: row.page_number, box: row.bounding_box } : null,
    };
  }, [selectedField, lineItems]);

  // ---- 選択 ----
  const selectFromViewer = useCallback((id: string) => {
    setSelectedId(id);
    setTab("fields");
    scrollToField.current = id;
  }, []);
  useEffect(() => {
    const id = scrollToField.current;
    if (!id) return;
    scrollToField.current = null;
    const el = document.getElementById(`field-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (window.matchMedia("(min-width: 1024px)").matches) el.querySelector<HTMLElement>("input,textarea")?.focus({ preventScroll: true });
  }, [selectedId, tab]);
  const locate = useCallback((id: string) => {
    setSelectedId(id);
    setTab("original");
  }, []);

  // ---- 入力 ----
  const onChange = useCallback((id: string, value: string) => setDraft((d) => ({ ...d, values: { ...d.values, [id]: value } })), []);
  const onToggleConfirm = useCallback((ids: string[], value: boolean) => {
    setDraft((d) => ({ ...d, confirms: { ...d.confirms, ...Object.fromEntries(ids.map((id) => [id, value])) } }));
  }, []);

  // ---- 保存 ----
  const commit = useCallback(async (extra: ReviewChange[] = []): Promise<{ ok: boolean; openIssues: number | null }> => {
    const sent = draft;
    const all: ReviewChange[] = [...buildChanges(type, fields, sent), ...extra];
    if (all.length === 0) return { ok: true, openIssues: doc.open_issue_count };
    const res = await safeAction(() => saveReview(doc.id, versionRef.current, all));
    if (!res.ok) {
      if (res.stale) toast.error(res.error, { action: { label: "再読み込み", onClick: () => router.refresh() } });
      else toast.error(res.error);
      return { ok: false, openIssues: null };
    }
    if (res.data) versionRef.current = res.data.version;
    // 保存中にさらに入力した分は残す
    setDraft((cur) => ({
      values: Object.fromEntries(Object.entries(cur.values).filter(([k, v]) => sent.values[k] !== v)),
      confirms: Object.fromEntries(Object.entries(cur.confirms).filter(([k, v]) => sent.confirms[k] !== v)),
    }));
    return { ok: true, openIssues: res.data?.openIssues ?? null };
  }, [draft, type, fields, doc.id, doc.open_issue_count, router]);

  const run = useCallback(async (kind: Busy, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const save = useCallback(() => run("save", async () => {
    const r = await commit();
    if (r.ok) toast.success(r.openIssues ? `保存しました（確認事項 ${r.openIssues}件）` : "保存しました");
  }), [run, commit]);

  const overLimit = role === "staff" && staffConfirmLimit !== null && (doc.total_amount ?? 0) > staffConfirmLimit;
  const canConfirm = editable && (doc.status === "needs_review" || doc.status === "ready") && isKnownType(type) && !overLimit && (changes.length > 0 || openCount === 0);

  const confirm = useCallback(() => run("confirm", async () => {
    const saved = await commit();
    if (!saved.ok) return;
    if ((saved.openIssues ?? 0) > 0) {
      toast.error(`確認事項が ${saved.openIssues}件 残っているため、確定できません`);
      return;
    }
    const res = await safeAction(() => confirmDocument(doc.id, versionRef.current));
    if (!res.ok) {
      toast.error(res.error, res.stale ? { action: { label: "再読み込み", onClick: () => router.refresh() } } : undefined);
      return;
    }
    toast.success("確定しました", nav.nextReview ? { action: { label: "次の要確認へ", onClick: () => router.push(`/documents/${nav.nextReview}`) } } : undefined);
  }), [run, commit, doc.id, nav.nextReview, router]);

  const simple = useCallback((fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => run("other", async () => {
    const res = await safeAction(fn);
    if (!res.ok) toast.error("error" in res ? res.error : "処理できませんでした");
    else if (done) toast.success(done);
  }), [run]);

  // Ctrl+S（⌘S）で保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (editable && changes.length > 0) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, changes.length, save]);

  // 保存していない変更があるまま閉じようとしたとき
  useEffect(() => {
    if (changes.length === 0) return;
    const onBefore = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [changes.length]);

  // 読み取り中は状態を確かめ、終わったら表示し直す
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/documents/status?ids=${doc.id}`, { cache: "no-store" });
        const json = (await res.json()) as { documents?: { status: string }[] };
        const s = json.documents?.[0]?.status;
        if (s && s !== doc.status) router.refresh();
      } catch {
        // 次の確認で取り直す
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [working, doc.id, doc.status, router]);

  const guardLeave = (href: string) => (e: React.MouseEvent) => {
    if (changes.length === 0) return;
    e.preventDefault();
    toast.warning("保存していない変更があります", { action: { label: "破棄して移動", onClick: () => router.push(href) } });
  };

  const notice = selectedField ? noBoxNotice(type, selectedField) : null;
  const isPdf = doc.mime_type === "application/pdf";

  // ---- 表示 ----
  return (
    <div data-review-screen className="pb-16 md:pb-0 lg:grid lg:h-full lg:grid-rows-[auto_minmax(0,1fr)] lg:pb-0">
      {/* 書類の見出し */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-card px-4 py-2 sm:px-6">
        <Link href="/documents" onClick={guardLeave("/documents")} className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" aria-hidden />書類
        </Link>
        <h1 className="min-w-0 max-w-full truncate text-sm font-semibold sm:max-w-[40%] sm:text-base" title={doc.filename}>{doc.filename}</h1>
        <DocumentStatusBadge status={doc.status} issues={openCount} />
        {editable ? (
          <Select value={isKnownType(type) ? type : ""} onValueChange={(v) => v !== type && setDialog({ kind: "type", type: v as KnownType })}>
            <SelectTrigger className="h-8 w-auto min-w-24 px-2.5 text-xs" aria-label="書類種別"><SelectValue placeholder="種別を選ぶ" /></SelectTrigger>
            <SelectContent>
              {KNOWN_TYPES.map((t) => <SelectItem key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs">{DOCUMENT_TYPE_LABELS[type ?? "unknown"]}</span>
        )}
        {result?.is_precomputed && <Badge variant="info" title="事前に処理して保存した結果を表示しています（デモ用）">事前処理の結果</Badge>}
        {doc.is_sample && <Badge variant="neutral">サンプル</Badge>}
        <span className="hidden text-xs text-muted-foreground xl:inline">{methodLabel(doc.extraction_method)}</span>
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="そのほかの操作"><EllipsisVertical /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem asChild><a href={`/api/documents/${doc.id}/file?download=1`}><Download aria-hidden />原本をダウンロード</a></DropdownMenuItem>
              {canReview && doc.status !== "confirmed" && doc.status !== "excluded" && (
                <DropdownMenuItem disabled={working || !!busy} onSelect={() => simple(() => reprocessDocument(doc.id, null), "読み直しを始めました")}><RefreshCw aria-hidden />読み直す</DropdownMenuItem>
              )}
              {canReview && doc.status === "excluded" && (
                <DropdownMenuItem onSelect={() => simple(() => setExcluded(doc.id, false), "除外を取り消しました")}><Undo2 aria-hidden />除外を取り消す</DropdownMenuItem>
              )}
              {canReview && editable && (
                <DropdownMenuItem onSelect={() => { setReason(""); setDialog({ kind: "exclude" }); }}><RotateCcw aria-hidden />除外する</DropdownMenuItem>
              )}
              {can.delete(role) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDialog({ kind: "delete" })}><Trash2 aria-hidden />削除</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* スマートフォン・タブレット：タブ */}
      <div className="sticky top-14 z-20 grid grid-cols-2 border-b bg-card lg:hidden" role="tablist" aria-label="表示の切り替え">
        {(["original", "fields"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("h-11 border-b-2 text-sm", tab === t ? "border-brand font-semibold text-foreground" : "border-transparent text-muted-foreground")}
          >
            {t === "original" ? "原本" : <>項目{openCount > 0 && <span className="tabular ml-1 rounded-full bg-warning-soft px-1.5 text-[11px] text-warning-strong">{openCount}</span>}</>}
          </button>
        ))}
      </div>

      <div className="lg:grid lg:min-h-0 lg:grid-cols-[55fr_45fr]">
        {/* 原本 */}
        <div className={cn("h-[calc(100dvh-15rem)] min-h-[380px] lg:block lg:h-auto lg:min-h-0 lg:border-r", tab === "original" ? "block" : "hidden")}>
          {pages.length > 0 ? (
            <DocumentViewer documentId={doc.id} isPdf={isPdf} pages={pages} highlights={highlights} selected={selected} onSelect={selectFromViewer} notice={notice} />
          ) : (
            <div className="flex h-full items-center justify-center bg-muted/60 p-6 text-sm text-muted-foreground">
              {working ? <><Loader2 className="mr-2 size-4 animate-spin" aria-hidden />読み取っています</> : "原本を表示できません（読み取りが完了していません）"}
            </div>
          )}
        </div>

        {/* 項目 */}
        <div className="flex min-h-0 flex-col bg-card">
          <div className={cn("lg:min-h-0 lg:flex-1 lg:overflow-y-auto", tab === "fields" ? "block" : "hidden lg:block")} data-testid="review-pane">
            {working && (
              <div className="m-4 flex items-center gap-2 rounded-md border bg-info-soft px-3 py-2 text-sm text-info-strong" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {doc.status === "queued" ? "読み取りの順番を待っています" : "読み取っています"}。画面を閉じても処理は続きます
              </div>
            )}
            {doc.status === "error" && (
              <div className="m-4 rounded-md border border-destructive/30 bg-danger-soft/60 px-3 py-2 text-sm" role="alert">
                <div className="font-medium text-danger-strong">読み取れませんでした</div>
                {doc.error_message && <div className="mt-0.5 text-xs text-muted-foreground">{doc.error_message}</div>}
                {canReview && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => simple(() => reprocessDocument(doc.id, null), "読み直しを始めました")}><RefreshCw aria-hidden />読み直す</Button>
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setReason(""); setDialog({ kind: "exclude" }); }}>除外する</Button>
                  </div>
                )}
              </div>
            )}
            {doc.status === "excluded" && (
              <div className="m-4 rounded-md border bg-muted px-3 py-2 text-sm" role="status">除外した書類です。一覧と出力の対象から外れています。</div>
            )}
            {doc.status === "confirmed" && (
              <div className="m-4 rounded-md border border-success/30 bg-success-soft/60 px-3 py-2 text-sm text-success-strong" role="status">
                確定済み（{doc.confirmed_at ? formatDateTimeFull(doc.confirmed_at) : ""}{doc.confirmed_by_name ? `・${doc.confirmed_by_name}` : ""}）。直すときは「再確認」してください
              </div>
            )}
            {overLimit && editable && (
              <div className="m-4 rounded-md border bg-warning-soft px-3 py-2 text-xs text-warning-strong" role="status">
                合計 {formatYen(staffConfirmLimit)} を超える書類は、管理者が確定します。確認と保存はできます
              </div>
            )}

            {!working && !isKnownType(type) && doc.status !== "error" && (
              <div className="m-4 rounded-md border border-destructive/30 bg-danger-soft/50 px-3 py-2 text-sm">
                <div className="font-medium text-danger-strong">書類種別を判定できませんでした</div>
                <div className="mt-0.5 text-xs text-muted-foreground">上の「種別を選ぶ」で請求書・領収書・納品書を選ぶと、その種別として項目を取り出し直します（読み取った文字は使い回します）。</div>
              </div>
            )}

            {(openCount > 0 || issues.length > 0 || duplicates.length > 0) && (
              <Section title="確認事項" id="sec-issues" count={openCount > 0 ? <span className="tabular rounded-full bg-warning-soft px-1.5 text-xs text-warning-strong">{openCount}</span> : <span className="text-xs text-success-strong">すべて対応済み</span>}>
                <div className="px-4 pb-3">
                  <IssuePanel
                    issues={issues}
                    duplicates={duplicates}
                    fieldLabel={(id) => {
                      const f = id ? fieldById.get(id) : null;
                      return f ? labelOf(type, f) : null;
                    }}
                    pendingConfirm={(id) => !!id && draft.confirms[id] === true}
                    editable={editable}
                    busy={!!busy}
                    onSelectField={(id) => setSelectedId(id)}
                    onConfirmField={(id) => onToggleConfirm([id], true)}
                    onAccept={(issueId, r) => run("other", async () => {
                      const res = await commit([{ op: "accept_issue", issueId, reason: r }]);
                      if (res.ok) toast.success("承認しました");
                    })}
                    onReopen={(issueId) => run("other", async () => {
                      await commit([{ op: "reopen_issue", issueId }]);
                    })}
                    onDecideDuplicate={(candidateId, decision) => simple(() => decideDuplicate(candidateId, decision), decision === "duplicate" ? "重複として除外しました" : decision === "not_duplicate" ? "重複ではないと記録しました" : undefined)}
                  />
                </div>
              </Section>
            )}

            {head.length > 0 && (
              <Section
                title="項目"
                id="sec-fields"
                action={
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" className="size-3.5 accent-[var(--success)]" checked={showConfirmed} onChange={(e) => setShowConfirmed(e.target.checked)} />
                    確認済みの印も表示
                  </label>
                }
              >
                <HeaderFields type={type} fields={head} draft={draft} selectedId={selectedId} issuesByField={issuesByField} editable={editable} onChange={onChange} onToggleConfirm={onToggleConfirm} onSelect={setSelectedId} onLocate={locate} />
              </Section>
            )}

            {isKnownType(type) && (
              <Section title="明細" id="sec-lines" count={<span className="tabular text-xs text-muted-foreground">{groups.length}行</span>}>
                <LineItems
                  type={type}
                  groups={groups}
                  draft={draft}
                  selectedId={selectedId}
                  issuesByField={issuesByField}
                  editable={editable}
                  busy={!!busy}
                  onChange={onChange}
                  onToggleConfirm={onToggleConfirm}
                  onSelect={setSelectedId}
                  onLocate={locate}
                  onAdd={() => run("other", async () => { await commit([{ op: "add_line" }]); })}
                  onRemove={(line) => setDialog({ kind: "remove_line", line })}
                />
              </Section>
            )}

            {isKnownType(type) && (
              <Section title="金額の照合" id="sec-checks">
                <AmountChecks
                  checks={checks}
                  onSelect={(ref) => {
                    const f = fields.find((x) => x.field_key === ref.key && x.line_index === ref.line);
                    if (f) setSelectedId(f.id);
                  }}
                />
                {changes.length > 0 && <p className="px-4 pb-2 text-[11px] text-muted-foreground">保存すると、直した値で照合し直します。</p>}
              </Section>
            )}

            <details className="border-b">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">読み取りの情報</summary>
              <ExtractionInfo detail={detail} />
            </details>
            <details className="border-b" data-testid="history">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">履歴 <span className="font-normal text-muted-foreground">{history.length}件</span></summary>
              <HistoryList rows={history} type={type} />
            </details>
            <div className="h-6" />
          </div>

          {/* 操作（スマートフォンは下のメニューの上に固定） */}
          <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 flex items-center gap-2 border-t bg-card px-3 py-2 md:bottom-0 lg:static lg:px-4">
            <Button asChild variant="ghost" size="sm" className={cn(!nav.prev && "pointer-events-none opacity-40")} aria-disabled={!nav.prev}>
              <Link href={nav.prev ? `/documents/${nav.prev}` : "#"} onClick={nav.prev ? guardLeave(`/documents/${nav.prev}`) : undefined} aria-label="前の書類"><ArrowLeft aria-hidden /><span className="hidden sm:inline">前の書類</span></Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className={cn(!nav.nextReview && "pointer-events-none opacity-40")} aria-disabled={!nav.nextReview}>
              <Link href={nav.nextReview ? `/documents/${nav.nextReview}` : "#"} onClick={nav.nextReview ? guardLeave(`/documents/${nav.nextReview}`) : undefined} aria-label="次の要確認"><span className="hidden sm:inline">次の要確認</span><ArrowRight aria-hidden /></Link>
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {changes.length > 0 && <span className="hidden text-xs text-info-strong sm:inline" aria-live="polite">未保存 {changes.length}件</span>}
              {editable && (
                <>
                  <Button variant="outline" size="sm" onClick={save} disabled={changes.length === 0 || !!busy} data-testid="save">
                    {busy === "save" && <Loader2 className="animate-spin" aria-hidden />}保存
                  </Button>
                  {(doc.status === "needs_review" || doc.status === "ready") && (
                    <Button
                      variant="brand"
                      size="sm"
                      onClick={confirm}
                      disabled={!canConfirm || !!busy}
                      title={!canConfirm ? (overLimit ? "管理者が確定します" : !isKnownType(type) ? "書類種別を選んでください" : `確認事項 ${openCount}件を解消すると確定できます`) : undefined}
                      data-testid="confirm"
                    >
                      {busy === "confirm" && <Loader2 className="animate-spin" aria-hidden />}
                      {changes.length > 0 ? "保存して確定" : "確定"}
                    </Button>
                  )}
                </>
              )}
              {canReview && doc.status === "confirmed" && (
                <Button variant="outline" size="sm" onClick={() => { setReason(""); setDialog({ kind: "reopen" }); }} disabled={!!busy}>再確認</Button>
              )}
              {!canReview && <span className="text-xs text-muted-foreground">閲覧のみ</span>}
            </div>
          </div>
        </div>
      </div>

      {/* 確かめの画面 */}
      <AlertDialog open={dialog?.kind === "type"} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog?.kind === "type" ? `${DOCUMENT_TYPE_LABELS[dialog.type]}として読み直しますか？` : ""}</AlertDialogTitle>
            <AlertDialogDescription>読み取った文字はそのまま使い、項目を取り出し直します。この書類で直した値と確認は消えます（履歴には残ります）。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction onClick={() => dialog?.kind === "type" && simple(() => reprocessDocument(doc.id, dialog.type), "読み直しを始めました")}>読み直す</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog?.kind === "remove_line"} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>明細の行を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>保存していない変更も一緒に保存します。削除した記録は履歴に残ります。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => dialog?.kind === "remove_line" && run("other", async () => { await commit([{ op: "remove_line", line: dialog.line }]); })}>削除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog?.kind === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>この書類を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>読み取った内容と確認の記録も消え、元に戻せません。重複などで外すだけなら「除外する」を使ってください。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => run("other", async () => {
                const res = await safeAction(() => deleteDocument(doc.id));
                if (!res.ok) toast.error(res.error);
                else {
                  toast.success("削除しました");
                  router.push("/documents");
                }
              })}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialog?.kind === "reopen" || dialog?.kind === "exclude"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.kind === "reopen" ? "確定を取り消して再確認する" : "この書類を除外する"}</DialogTitle>
            <DialogDescription>
              {dialog?.kind === "reopen" ? "確定したときの値は記録に残ります。理由を入力してください。" : "削除はせず、一覧と出力の対象から外します。あとで戻せます。"}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} aria-label="理由" placeholder={dialog?.kind === "reopen" ? "例：金額の修正依頼があったため" : "例：同じ請求書を二重にアップロードしたため"} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>やめる</Button>
            <Button
              variant={dialog?.kind === "exclude" ? "destructive" : "brand"}
              disabled={(dialog?.kind === "reopen" && !reason.trim()) || !!busy}
              onClick={() => {
                const kind = dialog?.kind;
                setDialog(null);
                if (kind === "reopen") simple(() => reopenDocument(doc.id, reason), "再確認に戻しました");
                else simple(() => setExcluded(doc.id, true, reason), "除外しました");
              }}
            >
              {dialog?.kind === "reopen" ? "再確認する" : "除外する"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
