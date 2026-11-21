"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { OrgRole } from "@/lib/domain/labels";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { isActive, MAIN_NAV, visible } from "./nav";
import { UserMenu } from "./user-menu";

/** 上のメニュー（PC）。確認画面の横幅を広く使うため、左のメニューは置かない */
export function AppHeader({ displayName, role, isDemo, reviewCount }: { displayName: string; role: OrgRole; isDemo: boolean; reviewCount: number }) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b bg-card">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4 sm:px-6">
        <Link href="/dashboard" aria-label="ホームへ" className="shrink-0">
          <Logo />
        </Link>
        <nav aria-label="メインメニュー" className="hidden items-center gap-1 md:flex">
          {visible(MAIN_NAV, role).map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center gap-1.5 rounded-md px-3 text-sm transition-colors",
                  active ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                )}
              >
                {item.label}
                {item.href === "/documents" && reviewCount > 0 && (
                  <span className="tabular rounded-full bg-warning-soft px-1.5 text-[11px] leading-5 font-semibold text-warning-strong" aria-label={`要確認 ${reviewCount} 件`}>
                    {reviewCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <UserMenu displayName={displayName} role={role} isDemo={isDemo} />
        </div>
      </div>
    </header>
  );
}

/** スマートフォンの下のタブ */
export function BottomNav({ role, reviewCount }: { role: OrgRole; reviewCount: number }) {
  const pathname = usePathname();
  const items = visible(MAIN_NAV, role);
  return (
    <nav aria-label="メインメニュー" className="fixed inset-x-0 bottom-0 z-30 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn("relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px]", active ? "font-semibold text-brand" : "text-muted-foreground")}
            >
              <item.icon className="size-5" aria-hidden />
              {item.label}
              {item.href === "/documents" && reviewCount > 0 && (
                <span className="tabular absolute top-1.5 left-1/2 ml-2 min-w-4 rounded-full bg-warning px-1 text-center text-[10px] leading-4 font-bold text-white" aria-label={`要確認 ${reviewCount} 件`}>
                  {reviewCount}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
