"use client";
/**
 * 原本の表示（PDF は pdf.js でページごとに描画、画像は向きを直した表示用の PNG）。
 * 拡大・縮小・回転・ページ移動に対応し、項目の位置に印を付ける（座標の計算は src/lib/viewer/coords.ts）。
 * 原本の位置が分からない項目には印を出さない（架空の位置に印を付けない）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Maximize2, Minus, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hitTest, isUsableBox, normalizeRotation, padRect, rotatedSize, scrollToReveal, toNormalizedPoint, toScreenRect, type Box, type Rotation } from "@/lib/viewer/coords";
import { cn } from "@/lib/utils";

/** tone：warning＝要確認（黄）、danger＝不整合（赤）、confirmed＝確認済み（緑）、none＝印は出さず、押せば選べる枠だけ */
export type Highlight = { id: string; page: number; box: Box; tone: "warning" | "danger" | "confirmed" | "none"; label: string };
export type PageMeta = { page_number: number; width: number; height: number };

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const GAP = 16;
const PAD = 16;

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfPage = {
  rotate: number;
  getViewport: (o: { scale: number; rotation?: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas?: HTMLCanvasElement }) => { promise: Promise<void>; cancel: () => void };
};

const TONE: Record<Highlight["tone"], string> = {
  warning: "border-warning bg-warning/15",
  danger: "border-destructive bg-destructive/12",
  confirmed: "border-success bg-success/10",
  none: "border-transparent bg-transparent hover:border-brand/50 hover:bg-brand/5",
};

function PdfCanvas({ pdf, pageNumber, cssWidth, cssHeight, rotation, onRendered }: { pdf: PdfDoc; pageNumber: number; cssWidth: number; cssHeight: number; rotation: Rotation; onRendered?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const timer = setTimeout(async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled || !ref.current) return;
      const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = rotatedSize(cssWidth, cssHeight, rotation);
      // 大きすぎる画像にしない（1辺 4096px まで）
      const scale = Math.min((size.width * dpr) / base.width, 4096 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      const canvas = ref.current;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const t = page.render({ canvasContext: ctx, viewport, canvas });
      task = t;
      try {
        await t.promise;
        if (!cancelled) onRendered?.();
      } catch {
        // 描画の途中で倍率が変わったときは取り消される
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [pdf, pageNumber, cssWidth, cssHeight, rotation, onRendered]);
  const size = rotatedSize(cssWidth, cssHeight, rotation);
  return <canvas ref={ref} style={{ width: size.width, height: size.height }} className="absolute inset-0 bg-white" aria-hidden />;
}

function RotatedImage({ src, cssWidth, cssHeight, rotation, onLoad }: { src: string; cssWidth: number; cssHeight: number; rotation: Rotation; onLoad: () => void }) {
  // 回転は左上を軸に回し、ずれた分を戻す（座標の変換 toScreenRect と同じ向き・同じ位置）
  const transform = rotation === 90 ? `translate(${cssHeight}px, 0) rotate(90deg)`
    : rotation === 180 ? `translate(${cssWidth}px, ${cssHeight}px) rotate(180deg)`
    : rotation === 270 ? `translate(0, ${cssWidth}px) rotate(270deg)` : undefined;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" draggable={false} onLoad={onLoad} className="absolute top-0 left-0 max-w-none select-none" style={{ width: cssWidth, height: cssHeight, transformOrigin: "0 0", transform, imageOrientation: "none" }} />
  );
}

export function DocumentViewer({
  documentId, isPdf, pages, highlights, selected, onSelect, notice,
}: {
  documentId: string;
  isPdf: boolean;
  pages: PageMeta[];
  highlights: Highlight[];
  selected: { id: string; page: number | null; box: Box | null; rowBox?: { page: number; box: Box } | null } | null;
  onSelect: (id: string) => void;
  notice?: string | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [pdf, setPdf] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [ready, setReady] = useState(!isPdf ? 0 : -1);

  // 表示領域の幅（幅に合わせる倍率の基準）
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // PDF の読み込み（閉じるときは読み込みの処理ごと破棄する）
  useEffect(() => {
    if (!isPdf) return;
    let task: { destroy: () => Promise<void> } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const lib = await import("pdfjs-dist");
        if (cancelled) return;
        lib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const loading = lib.getDocument({
          url: `/api/documents/${documentId}/file`,
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          enableXfa: false,
          withCredentials: true,
        });
        task = loading;
        const doc = (await loading.promise) as unknown as PdfDoc;
        if (cancelled) return;
        setPdf(doc);
        setReady(0);
      } catch (e) {
        if (cancelled) return;
        console.error(e);
        setError("原本を表示できませんでした");
      }
    })();
    return () => {
      cancelled = true;
      setPdf(null);
      setReady(-1);
      void task?.destroy().catch(() => {});
    };
  }, [documentId, isPdf]);

  // 倍率：1 = 表示領域の幅に合わせる
  const maxRotatedWidth = Math.max(1, ...pages.map((p) => rotatedSize(p.width, p.height, rotation).width));
  const fit = containerWidth > 0 ? (containerWidth - PAD * 2) / maxRotatedWidth : 0;
  const scale = fit * zoom;
  const layout = useMemo(() => {
    type Item = PageMeta & { cssWidth: number; cssHeight: number; size: { width: number; height: number }; top: number };
    const out: Item[] = [];
    for (const p of pages) {
      const cssWidth = p.width * scale;
      const cssHeight = p.height * scale;
      const prev = out[out.length - 1];
      out.push({ ...p, cssWidth, cssHeight, size: rotatedSize(cssWidth, cssHeight, rotation), top: prev ? prev.top + prev.size.height + GAP : PAD });
    }
    return out;
  }, [pages, scale, rotation]);
  const contentWidth = Math.max(containerWidth, ...layout.map((l) => l.size.width + PAD * 2));
  const contentHeight = layout.length ? layout[layout.length - 1].top + layout[layout.length - 1].size.height + PAD : 0;
  const leftOf = (w: number) => Math.max(PAD, (contentWidth - w) / 2);

  // 選んだ項目の位置までスクロール（ページをまたいでも）
  useEffect(() => {
    const el = scroller.current;
    if (!el || !selected || selected.page === null || !selected.box || !isUsableBox(selected.box) || scale <= 0) return;
    const l = layout.find((p) => p.page_number === selected.page);
    if (!l) return;
    const rect = toScreenRect(selected.box, l.cssWidth, l.cssHeight, rotation);
    const target = scrollToReveal(rect, { left: leftOf(l.size.width), top: l.top }, { scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
    if (target) el.scrollTo({ ...target, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.page, scale, rotation]);

  // いま見えているページ
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    const found = [...layout].reverse().find((l) => l.top <= mid);
    setCurrentPage(found?.page_number ?? 1);
  }, [layout]);

  const goPage = (n: number) => {
    const l = layout.find((p) => p.page_number === n);
    if (l && scroller.current) scroller.current.scrollTo({ top: l.top - PAD, behavior: "smooth" });
  };

  const zoomIndex = ZOOMS.findIndex((z) => Math.abs(z - zoom) < 0.01);
  const setZoomStep = (d: number) => {
    const i = zoomIndex < 0 ? ZOOMS.findIndex((z) => z > zoom) - (d > 0 ? 0 : 1) : zoomIndex + d;
    setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i))]);
  };

  const onPageClick = (e: React.MouseEvent<HTMLDivElement>, l: (typeof layout)[number]) => {
    const r = e.currentTarget.getBoundingClientRect();
    const point = toNormalizedPoint(e.clientX - r.left, e.clientY - r.top, l.cssWidth, l.cssHeight, rotation);
    const hit = hitTest(highlights.filter((h) => h.page === l.page_number), point);
    if (hit) onSelect(hit.id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/60">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b bg-card px-2">
        <Button variant="ghost" size="icon-sm" onClick={() => setZoomStep(-1)} aria-label="縮小" disabled={zoom <= ZOOMS[0]}><Minus /></Button>
        <span className="tabular w-12 text-center text-xs text-muted-foreground" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <Button variant="ghost" size="icon-sm" onClick={() => setZoomStep(1)} aria-label="拡大" disabled={zoom >= ZOOMS[ZOOMS.length - 1]}><Plus /></Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setZoom(1)} aria-label="幅に合わせる"><Maximize2 /></Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setRotation((r) => normalizeRotation(r + 90))} aria-label="右に回転"><RotateCw /></Button>
        {pages.length > 1 && (
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => goPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} aria-label="前のページ"><ChevronLeft /></Button>
            <span className="tabular text-xs text-muted-foreground">{currentPage} / {pages.length}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => goPage(Math.min(pages.length, currentPage + 1))} disabled={currentPage >= pages.length} aria-label="次のページ"><ChevronRight /></Button>
          </div>
        )}
      </div>
      {notice && <div className="shrink-0 border-b bg-warning-soft px-3 py-1.5 text-xs text-warning-strong" role="status">{notice}</div>}
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto" data-testid="viewer-scroll">
        {error && <div className="p-6 text-sm text-destructive">{error}</div>}
        {!error && (ready < 0 || scale <= 0) && (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />原本を読み込んでいます</div>
        )}
        {!error && scale > 0 && ready >= 0 && (
          <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
            {layout.map((l) => {
              const pageHighlights = highlights.filter((h) => h.page === l.page_number && isUsableBox(h.box));
              return (
                <div
                  key={l.page_number}
                  data-page={l.page_number}
                  className="absolute overflow-hidden bg-white shadow-[0_0_0_1px_var(--border)]"
                  style={{ top: l.top, left: leftOf(l.size.width), width: l.size.width, height: l.size.height }}
                  onClick={(e) => onPageClick(e, l)}
                >
                  {isPdf ? (
                    pdf && <PdfCanvas pdf={pdf} pageNumber={l.page_number} cssWidth={l.cssWidth} cssHeight={l.cssHeight} rotation={rotation} />
                  ) : (
                    <RotatedImage src={`/api/documents/${documentId}/file?preview=1`} cssWidth={l.cssWidth} cssHeight={l.cssHeight} rotation={rotation} onLoad={() => setReady((n) => n + 1)} />
                  )}
                  {selected?.rowBox && selected.rowBox.page === l.page_number && isUsableBox(selected.rowBox.box) && (() => {
                    const r = padRect(toScreenRect(selected.rowBox.box, l.cssWidth, l.cssHeight, rotation), 3, l.size);
                    return <div className="pointer-events-none absolute rounded-[3px] bg-brand/6 ring-1 ring-brand/30" style={r} aria-hidden />;
                  })()}
                  {pageHighlights.map((h) => {
                    const isSel = selected?.id === h.id;
                    const r = padRect(toScreenRect(h.box, l.cssWidth, l.cssHeight, rotation), 2, l.size);
                    return (
                      <button
                        key={h.id}
                        type="button"
                        title={h.label}
                        aria-label={`${h.label}の位置`}
                        data-highlight={h.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(h.id);
                        }}
                        className={cn("absolute rounded-[3px] border transition-colors", isSel ? "z-10 border-2 border-brand bg-brand/12" : TONE[h.tone])}
                        style={r}
                      />
                    );
                  })}
                  {/* 選んだ項目が、印を出していない項目（正常）のときも枠を出す */}
                  {selected && selected.page === l.page_number && selected.box && isUsableBox(selected.box) && !pageHighlights.some((h) => h.id === selected.id) && (() => {
                    const r = padRect(toScreenRect(selected.box, l.cssWidth, l.cssHeight, rotation), 2, l.size);
                    return <div data-highlight={selected.id} className="pointer-events-none absolute z-10 rounded-[3px] border-2 border-brand bg-brand/12" style={r} aria-hidden />;
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
