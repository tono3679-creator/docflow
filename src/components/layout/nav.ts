import { FileText, History, LayoutDashboard, Settings, Upload, type LucideIcon } from "lucide-react";
import type { OrgRole } from "@/lib/domain/labels";

export type NavItem = { href: string; label: string; icon: LucideIcon; roles?: OrgRole[] };

/**
 * メニューは5つだけ（指示書の「一括処理」はアップロード、「出力」は書類の一覧の中にまとめた）。
 * スマートフォンでは下のタブ。
 */
export const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "ホーム", icon: LayoutDashboard },
  { href: "/documents", label: "書類", icon: FileText },
  { href: "/upload", label: "アップロード", icon: Upload, roles: ["admin", "staff"] },
  { href: "/history", label: "履歴", icon: History },
  { href: "/settings", label: "設定", icon: Settings },
];

export function visible(items: NavItem[], role: OrgRole) {
  return items.filter((i) => !i.roles || i.roles.includes(role));
}

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
