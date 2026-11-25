import { AppHeader, BottomNav } from "@/components/layout/app-header";
import { DemoBanner } from "@/components/layout/demo-banner";
import { asCurrentUser, requireUser } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [row] = await asCurrentUser((tx) => tx<{ n: number }[]>`select count(*)::int n from documents where status = 'needs_review'`);
  return (
    <div className="app-shell flex min-h-dvh flex-col">
      {user.isDemo && <DemoBanner role={user.role} />}
      <AppHeader displayName={user.displayName} role={user.role} isDemo={user.isDemo} reviewCount={row.n} />
      <div className="app-main flex-1 pb-20 md:pb-0">{children}</div>
      <BottomNav role={user.role} reviewCount={row.n} />
    </div>
  );
}
