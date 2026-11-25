"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronRight, FileUp, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { DocumentStatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import type { DocumentStatus } from "@/lib/domain/labels";
import { DOCUMENT_TYPE_LABELS } from "@/lib/extraction/schema";
import type { DocumentType } from "@/lib/extraction/types";
import { cn } from "@/lib/utils";

type Item = {
  key: string;
  file: File;
  state: "waiting" | "sending" | "accepted" | "rejected";
  reason?: string;
  documentId?: string;
  duplicateOf?: { id: string; filename: string } | null;
  status?: DocumentStatus;
  type?: DocumentType | null;
  issues?: number;
  error?: string | null;
};

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";
const SEND_CONCURRENCY = 2;
const DONE: DocumentStatus[] = ["needs_review", "ready", "confirmed", "error", "excluded"];

const formatSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/**
 * アップロードと一括処理の進み具合。
 * ファイルは1つずつ送る（1つの失敗がほかに影響しない・関数の要求サイズの上限に収める）。
 * 受け付けた書類の読取は裏で進み、ここでは状態を数秒ごとに確かめて表示する（画面を閉じても処理は続く）。
 */
export function UploadPanel({ maxBytes, maxPages, isDemo, llmActive }: { maxBytes: number; maxPages: number; isDemo: boolean; llmActive: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const batchRef = useRef<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  const update = (key: string, patch: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  // 送信待ちの列（同時に2つまで送る）
  const queueRef = useRef<Item[]>([]);
  const activeRef = useRef(0);

  const send = useCallback(async (item: Item) => {
    update(item.key, { state: "sending" });
    const form = new FormData();
    form.append("files", item.file);
    form.append("batch", batchRef.current);
    try {
      const res = await fetch("/api/documents/upload", { method: "POST", body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        update(item.key, { state: "rejected", reason: json?.error ?? (res.status === 413 ? "ファイルが大きすぎます" : "受け付けられませんでした") });
        return;
      }
      const r = json.results?.[0];
      if (r?.ok) update(item.key, { state: "accepted", documentId: r.documentId, duplicateOf: r.duplicateOf, status: "queued" });
      else update(item.key, { state: "rejected", reason: r?.reason ?? "受け付けられませんでした" });
    } catch {
      update(item.key, { state: "rejected", reason: "通信できませんでした。接続を確認してください" });
    }
  }, []);

  const pump = useCallback(function next() {
    while (activeRef.current < SEND_CONCURRENCY && queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      activeRef.current++;
      void send(item).finally(() => {
        activeRef.current--;
        next();
      });
    }
  }, [send]);

  // 処理の状態を確かめる（終わっていない書類があるあいだ）
  const pendingIds = items.filter((i) => i.documentId && !DONE.includes(i.status ?? "queued")).map((i) => i.documentId as string);
  const pendingKey = pendingIds.join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/documents/status?ids=${pendingKey}`, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const json = (await res.json()) as { documents: { id: string; status: DocumentStatus; document_type: DocumentType | null; open_issue_count: number; error_message: string | null }[] };
        setItems((list) => list.map((i) => {
          const d = json.documents.find((x) => x.id === i.documentId);
          return d ? { ...i, status: d.status, type: d.document_type, issues: d.open_issue_count, error: d.error_message } : i;
        }));
      } catch {
        // 通信が切れても、次の確認で取り直す
      }
    };
    void tick();
    const timer = setInterval(tick, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingKey]);

  const addFiles = (files: FileList | File[]) => {
    if (!batchRef.current || items.every((i) => i.state === "rejected" || (i.documentId && DONE.includes(i.status ?? "queued")))) {
      batchRef.current = crypto.randomUUID();
    }
    const list = [...files].slice(0, 50).map((file, n): Item => {
      const key = `${Date.now()}-${n}-${file.name}`;
      if (file.size > maxBytes) return { key, file, state: "rejected", reason: `ファイルが大きすぎます（上限 ${formatSize(maxBytes)}）` };
      if (!/\.(pdf|png|jpe?g|webp)$/i.test(file.name)) return { key, file, state: "rejected", reason: "対応していない形式です（PDF・PNG・JPEG・WebP）" };
      return { key, file, state: "waiting" };
    });
    setItems((prev) => [...list, ...prev]);
    queueRef.current.push(...list.filter((i) => i.state === "waiting"));
    pump();
  };

  const accepted = items.filter((i) => i.state === "accepted");
  const finished = accepted.filter((i) => DONE.includes(i.status ?? "queued"));
  const counts = {
    review: accepted.filter((i) => i.status === "needs_review").length,
    ready: accepted.filter((i) => i.status === "ready").length,
    error: accepted.filter((i) => i.status === "error").length,
    rejected: items.filter((i) => i.state === "rejected").length,
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid gap-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
          className={cn("flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed bg-card px-6 py-12 text-center transition-colors", dragging ? "border-brand bg-brand-soft" : "border-border")}
        >
          <FileUp className="size-8 text-muted-foreground" aria-hidden />
          <div className="text-sm font-medium">ここにファイルをドロップ</div>
          <Button variant="brand" onClick={() => inputRef.current?.click()}>ファイルを選ぶ</Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            aria-label="アップロードするファイル"
            data-testid="upload-input"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <p className="text-xs text-muted-foreground">PDF・PNG・JPEG・WebP／1ファイル {formatSize(maxBytes)}・{maxPages}ページまで／複数可</p>
        </div>

        {items.length > 0 && (
          <section className="rounded-lg border bg-card" aria-label="アップロードした書類">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 text-sm">
              <span className="font-medium">処理 {finished.length} / {accepted.length}</span>
              {counts.review > 0 && <span className="text-warning-strong">要確認 {counts.review}</span>}
              {counts.ready > 0 && <span className="text-info-strong">確認待ち {counts.ready}</span>}
              {counts.error > 0 && <span className="text-danger-strong">エラー {counts.error}</span>}
              {counts.rejected > 0 && <span className="text-danger-strong">受付不可 {counts.rejected}</span>}
              {finished.length > 0 && finished.length === accepted.length && (
                <Link href="/documents?status=needs_review" className="ml-auto text-xs text-brand hover:underline">要確認の書類へ</Link>
              )}
            </div>
            <ul className="divide-y">
              {items.map((i) => (
                <li key={i.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="w-5 shrink-0">
                    {i.state === "rejected" ? <XCircle className="size-4 text-destructive" aria-label="受付不可" />
                      : i.state === "accepted" ? <CheckCircle2 className="size-4 text-success" aria-label="受付済み" />
                      : <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="送信中" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{i.file.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatSize(i.file.size)}
                      {i.type && i.status !== "queued" && i.status !== "processing" && ` ・ ${DOCUMENT_TYPE_LABELS[i.type]}`}
                      {i.state === "rejected" && <span className="text-destructive"> ・ {i.reason}</span>}
                      {i.duplicateOf && <span className="text-warning-strong"> ・ 同じファイルが登録済み（{i.duplicateOf.filename}）</span>}
                      {i.status === "error" && i.error && <span className="text-destructive"> ・ {i.error}</span>}
                      {i.status === "queued" && i.error && <span> ・ {i.error}</span>}
                    </div>
                  </div>
                  {i.state === "sending" && <span className="text-xs text-muted-foreground">送信中</span>}
                  {i.state === "waiting" && <span className="text-xs text-muted-foreground">待機中</span>}
                  {i.status && <DocumentStatusBadge status={i.status} issues={i.issues} />}
                  {i.documentId && DONE.includes(i.status ?? "queued") && (
                    <Link href={`/documents/${i.documentId}`} className="text-muted-foreground hover:text-foreground" aria-label={`${i.file.name} を確認`}>
                      <ChevronRight className="size-4" />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="grid content-start gap-4 text-sm">
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-2 flex items-center gap-2 font-medium"><ShieldCheck className="size-4 text-success" aria-hidden />書類の取り扱い</div>
          <ul className="grid gap-1.5 text-xs text-muted-foreground">
            <li>ファイルはこの組織の人だけが見られます（公開 URL はありません）</li>
            <li>文字の読み取り（OCR）はこのシステムのサーバーの中で行います</li>
            <li>外部の AI への送信：<span className="font-medium text-foreground">{llmActive ? "する（管理者が設定で有効化）" : "しない"}</span></li>
            {isDemo && <li>デモ環境のデータは24時間後に削除されます。個人情報や実際の取引の書類は使わないでください</li>}
          </ul>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-2 font-medium">サンプル書類</div>
          <ul className="grid gap-1 text-xs">
            <li><a className="text-brand hover:underline" href="/samples/sample-invoice.pdf" download>請求書（PDF）</a></li>
            <li><a className="text-brand hover:underline" href="/samples/sample-receipt.png" download>領収書（スキャン画像）</a></li>
            <li><a className="text-brand hover:underline" href="/samples/sample-delivery-note.pdf" download>納品書（PDF）</a></li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
