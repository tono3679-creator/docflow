import Link from "next/link";
import { ChevronRight, Upload } from "lucide-react";
import { KpiCard } from "@/components/common/kpi-card";
import { Page } from "@/components/common/page";
import { PageHeader, Panel, SectionTitle } from "@/components/common/page-header";
import { DocumentStatusBadge, TypeLabel } from "@/components/common/status";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { asCurrentUser, requireUser } from "@/lib/auth";
import { dashboardStats, recentDocuments, reviewQueue, type DocumentListRow } from "@/lib/data/documents";
import { can, ROLE_LABEL } from "@/lib/domain/labels";
import { startOfMonth } from "@/lib/domain/dates";
import { formatDateTimeFull, formatNumber, formatYen } from "@/lib/format";
import { todayFor } from "@/lib/today";

export const metadata = { title: "ホーム" };

function Row({ d, showIssues }: { d: DocumentListRow; showIssues?: boolean }) {
  return (
    <li>
      <Link href={`/documents/${d.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{d.issuer_name ?? d.filename}</div>
          <div className="mt-0.5 flex gap-2 text-xs text-muted-foreground">
            <TypeLabel type={d.document_type} />
            {d.document_number && <span className="truncate">{d.document_number}</span>}
            {!showIssues && <span>{formatDateTimeFull(d.uploaded_at)}</span>}
          </div>
        </div>
        <span className="tabular hidden text-sm sm:block">{d.total_amount !== null ? formatYen(d.total_amount) : ""}</span>
        <DocumentStatusBadge status={d.status} issues={showIssues ? d.open_issue_count : undefined} />
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const user = await requireUser();
  const { denied } = await searchParams;
  const today = todayFor(user);
  const { stats, queue, recent } = await asCurrentUser(async (tx) => ({
    stats: await dashboardStats(tx, startOfMonth(today), user.settings.timezone),
    queue: await reviewQueue(tx, 5),
    recent: await recentDocuments(tx, 6),
  }));
  return (
    <Page>
      <PageHeader
        title="ホーム"
        actions={can.upload(user.role) && (
          <Button asChild variant="brand">
            <Link href="/upload"><Upload aria-hidden />アップロード</Link>
          </Button>
        )}
      />
      {denied && (
        <p className="mb-4 rounded-md border bg-muted/60 px-3 py-2 text-sm text-muted-foreground" role="status">
          その画面は使えません（{ROLE_LABEL[user.role]}の権限では表示できません）
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="未処理" value={formatNumber(stats.queued)} unit="件" href="/documents?status=queued" />
        <KpiCard label="要確認" value={formatNumber(stats.needsReview)} unit="件" tone={stats.needsReview > 0 ? "warning" : undefined} href="/documents?status=needs_review" sub={[stats.ready > 0 && `確認待ち ${stats.ready}件`, stats.errors > 0 && `エラー ${stats.errors}件`].filter(Boolean).join("・") || undefined} />
        <KpiCard label="処理済み" value={formatNumber(stats.confirmed)} unit="件" href="/documents?status=confirmed" />
        <KpiCard label="今月処理" value={formatNumber(stats.thisMonth)} unit="件" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle action={<Link href="/documents?status=needs_review" className="text-xs text-brand hover:underline">すべて</Link>}>要確認</SectionTitle>
          <Panel>
            {queue.length === 0 ? <EmptyState title="確認が必要な書類はありません" /> : <ul className="divide-y">{queue.map((d) => <Row key={d.id} d={d} showIssues />)}</ul>}
          </Panel>
        </section>
        <section>
          <SectionTitle action={<Link href="/documents" className="text-xs text-brand hover:underline">一覧</Link>}>最近の書類</SectionTitle>
          <Panel>
            {recent.length === 0 ? <EmptyState title="まだ書類がありません" /> : <ul className="divide-y">{recent.map((d) => <Row key={d.id} d={d} />)}</ul>}
          </Panel>
        </section>
      </div>
    </Page>
  );
}
