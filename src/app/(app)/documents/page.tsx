import { Page } from "@/components/common/page";
import { PageHeader } from "@/components/common/page-header";
import { FilterTabs } from "@/components/common/filter-tabs";
import { Pagination } from "@/components/common/pagination";
import { DocumentFilters } from "@/components/documents/document-filters";
import { DocumentTable } from "@/components/documents/document-table";
import { asCurrentUser, requireUser } from "@/lib/auth";
import { listDocuments, STATUS_FILTERS } from "@/lib/data/documents";
import { can } from "@/lib/domain/labels";

export const metadata = { title: "書類" };

const TABS = [
  { value: "active", label: "すべて" },
  { value: "needs_review", label: "要確認", tone: "warning" as const },
  { value: "ready", label: "確認待ち" },
  { value: "confirmed", label: "処理済み" },
  { value: "queued", label: "未処理" },
  { value: "error", label: "エラー", tone: "danger" as const },
  { value: "excluded", label: "除外" },
];
const PER_PAGE = 50;

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).slice(0, 100) : "");
  const status = (STATUS_FILTERS as readonly string[]).includes(get("status")) ? get("status") : "active";
  const page = Math.max(1, Number(get("page")) || 1);
  const filter = { q: get("q"), status, type: get("type"), from: get("from"), to: get("to") };
  const { list, counts } = await asCurrentUser(async (tx) => ({
    list: await listDocuments(tx, { ...filter, page, perPage: PER_PAGE }),
    counts: Object.fromEntries((await tx<{ status: string; n: number }[]>`select status::text, count(*)::int n from documents group by status`).map((r) => [r.status, r.n])),
  }));
  const countFor = (v: string) =>
    v === "active" ? Object.entries(counts).filter(([k]) => k !== "excluded").reduce((n, [, c]) => n + c, 0)
      : v === "queued" ? (counts.queued ?? 0) + (counts.processing ?? 0) : counts[v] ?? 0;
  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams({ ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)), ...over });
    for (const [k, v] of [...p.entries()]) if (!v || (k === "status" && v === "active")) p.delete(k);
    const s = p.toString();
    return s ? `/documents?${s}` : "/documents";
  };
  return (
    <Page>
      <PageHeader title="書類" />
      <div className="mb-3 flex flex-col gap-3">
        <FilterTabs current={status} items={TABS.map((t) => ({ ...t, href: href({ status: t.value, page: "" }), count: countFor(t.value) }))} />
        <DocumentFilters q={filter.q} type={filter.type} from={filter.from} to={filter.to} />
      </div>
      <DocumentTable
        rows={list.rows}
        total={list.total}
        filter={filter}
        canExport={can.export(user.role)}
        canReprocess={can.review(user.role)}
      />
      <Pagination page={page} pageCount={Math.max(1, Math.ceil(list.total / PER_PAGE))} total={list.total} pageSize={PER_PAGE} hrefFor={(p) => href({ page: String(p) })} />
    </Page>
  );
}
