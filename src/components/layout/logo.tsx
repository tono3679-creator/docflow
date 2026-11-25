import { cn } from "@/lib/utils";

/** ロゴ：書類と、読み取った行を表す線（装飾は最小限） */
export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden>
        <rect x="4" y="2.5" width="16" height="19" rx="2.5" fill="var(--brand)" />
        <rect x="7.5" y="7" width="9" height="1.8" rx="0.9" fill="#fff" />
        <rect x="7.5" y="11" width="6" height="1.8" rx="0.9" fill="#fff" opacity="0.75" />
        <rect x="7.5" y="15" width="7.5" height="1.8" rx="0.9" fill="#fff" opacity="0.5" />
      </svg>
      <span className="text-[15px] font-bold tracking-tight text-foreground">DocFlow</span>
    </div>
  );
}
