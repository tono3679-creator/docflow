import Link from "next/link";
import { FilterTabs } from "@/components/common/filter-tabs";
import { Page } from "@/components/common/page";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader, Panel, SectionTitle } from "@/components/common/page-header";
import { asCurrentUser, requireUser } from "@/lib/auth";
import { exportHistory, orgHistory, type HistoryRow } from "@/lib/data/documents";
import { AUDIT_ACTION_LABEL, can, REVIEW_ACTION_LABEL, ROLE_LABEL, type OrgRole } from "@/lib/domain/labels";
import { EXPORT_TARGET_LABEL, type ExportTarget } from "@/lib/export";
import { displayValue } from "@/lib/extraction/normalize";
import { fieldDef, lineFieldDef } from "@/lib/extraction/schema";
import { formatDateTimeFull, formatNumber } from "@/lib/format";

export const metadata = { title: "履歴" };

/** 絞り込み（操作の種類のまとまり） */
const GROUPS = [
  { value: "all", label: "すべて", actions: [] as string[] },
  { value: "confirm", label: "確定・再確認", actions: ["confirm_document", "reopen_document"] },
  { value: "edit", label: "修正・確認", actions: ["edit", "confirm_field", "unconfirm_field", "add_line", "remove_line", "change_type"] },
  { value: "accept", label: "承認・重複", actions: ["accept_issue", "reopen_issue", "duplicate_decision", "exclude", "restore"] },
  { value: "read", label: "アップロード・読取", actions: ["document.upload", "document.processed", "document.failed", "document.reprocess", "document.delete"] },
  { value: "admin", label: "設定・メンバー", actions: ["settings.update", "member.add", "member.update"], adminOnly: true },
];

function fieldName(key: string | null, line: number | null): string | null {
  if (!key) return line !== null ? `明細${line + 1}` : null;
  if (line !== null) return `明細${line + 1} ${lineFieldDef(key)?.label ?? key}`;
  for (const t of ["invoice", "receipt", "delivery_note"] as const) {
    const d = fieldDef(t, key);
    if (d) return d.label;
  }
  return key;
}

function kindFor(key: string | null, line: number | null) {
  if (!key) return undefined;
  if (line !== null) return lineFieldDef(key)?.kind;
  for (const t of ["invoice", "receipt", "delivery_note"] as const) {
    const d = fieldDef(t, key);
    if (d) return d.kind;
  }
  return undefined;
}

const SETTING_LABEL: Record<string, string> = {
  max_file_mb: "ファイルの上限",
  max_pages: "ページ数の上限",
  confidence_threshold: "信頼度のしきい値",
  staff_confirm_limit: "担当者の確定上限",
  llm_enabled: "外部の AI",
};

function settingValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return key === "staff_confirm_limit" ? "なし" : "—";
  if (key === "llm_enabled") return v ? "使う" : "使わない";
  if (key === "confidence_threshold") return `${Math.round(Number(v) * 100)}%`;
  if (key === "max_file_mb") return `${v}MB`;
  if (key === "staff_confirm_limit") return `${Number(v).toLocaleString("ja-JP")}円`;
  return String(v);
}

/** 設定の変更：変わった項目だけ「前 → 後」で示す */
function settingsChanges(d: Record<string, unknown>): string {
  const before = (d.before ?? {}) as Record<string, unknown>;
  const after = (d.after ?? {}) as Record<string, unknown>;
  return Object.keys(SETTING_LABEL)
    .filter((k) => String(before[k]) !== String(after[k]) && !(k === "confidence_threshold" && Number(before[k]) === Number(after[k])))
    .map((k) => `${SETTING_LABEL[k]} ${settingValue(k, before[k])} → ${settingValue(k, after[k])}`)
    .join("、");
}

function Detail({ r }: { r: HistoryRow }) {
  const field = fieldName(r.field_key, r.line_index);
  const kind = kindFor(r.field_key, r.line_index);
  const d = (r.detail ?? {}) as Record<string, unknown>;
  return (
    <span className="text-muted-foreground">
      {field && <span className="mr-1.5 text-foreground">{field}</span>}
      {r.action === "edit" && <>{displayValue(kind, r.before_value) || "（空）"} → <span className="text-foreground">{displayValue(kind, r.after_value) || "（空）"}</span></>}
      {r.action === "accept_issue" && r.after_value && <>{r.after_value}</>}
      {r.action === "duplicate_decision" && (r.after_value === "duplicate" ? "重複" : r.after_value === "not_duplicate" ? "重複ではない" : "未判断に戻す")}
      {r.action === "document.failed" && typeof d.error === "string" && d.error}
      {r.action === "member.update" && typeof d.after === "object" && d.after && `役割 ${ROLE_LABEL[(d.after as { role: OrgRole }).role] ?? ""}・${(d.after as { active: boolean }).active ? "利用中" : "停止"}`}
      {r.action === "settings.update" && settingsChanges(d)}
      {r.action === "member.add" && typeof d.role === "string" && `役割 ${ROLE_LABEL[d.role as OrgRole] ?? d.role}`}
      {r.reason && <span className="block">理由：{r.reason}</span>}
    </span>
  );
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const groups = GROUPS.filter((g) => !g.adminOnly || can.auditAll(user.role));
  const group = groups.find((g) => g.value === sp.group) ?? groups[0];
  const { rows, exports } = await asCurrentUser(async (tx) => ({
    rows: await orgHistory(tx, { limit: 300, actions: group.actions }),
    exports: await exportHistory(tx, 20),
  }));

  return (
    <Page>
      <PageHeader title="履歴" sub="誰が・いつ・何を直し、確定したか" />
      <div className="mb-3">
        <FilterTabs current={group.value} items={groups.map((g) => ({ value: g.value, label: g.label, href: g.value === "all" ? "/history" : `/history?group=${g.value}` }))} />
      </div>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="記録はまだありません" />
        ) : (
          <ol className="divide-y" aria-label="操作の記録">
            {rows.map((r) => {
              const label = r.kind === "review" ? (REVIEW_ACTION_LABEL[r.action] ?? r.action) : (AUDIT_ACTION_LABEL[r.action] ?? r.action);
              return (
                <li key={r.id} className="grid gap-1 px-4 py-2.5 text-sm sm:grid-cols-[9.5rem_8.5rem_minmax(0,1fr)_7rem] sm:gap-3 sm:px-5">
                  <time className="tabular text-xs text-muted-foreground sm:pt-0.5" dateTime={new Date(r.at).toISOString()}>{formatDateTimeFull(r.at)}</time>
                  <span className="font-medium">{label}</span>
                  <span className="min-w-0">
                    {r.document_id && r.filename && (
                      <Link href={`/documents/${r.document_id}`} className="mr-2 inline-block max-w-full truncate align-bottom text-brand hover:underline">{r.filename}</Link>
                    )}
                    <Detail r={r} />
                  </span>
                  <span className="text-xs text-muted-foreground sm:pt-0.5 sm:text-right">{r.actor_name ?? "システム"}</span>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
      {rows.length >= 300 && <p className="mt-2 text-xs text-muted-foreground">新しい順に 300件まで表示しています。</p>}

      <SectionTitle className="mt-8">出力の記録</SectionTitle>
      <Panel>
        {exports.length === 0 ? (
          <EmptyState title="まだ出力していません" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-5 py-2 font-normal">日時</th>
                  <th scope="col" className="px-3 py-2 font-normal">形式</th>
                  <th scope="col" className="px-3 py-2 font-normal">対象</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">書類</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">行</th>
                  <th scope="col" className="px-5 py-2 font-normal">担当者</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {exports.map((e) => (
                  <tr key={e.id}>
                    <td className="tabular px-5 py-2 text-xs text-muted-foreground">{formatDateTimeFull(e.created_at)}</td>
                    <td className="px-3 py-2">{e.format === "xlsx" ? "Excel" : "CSV"}</td>
                    <td className="px-3 py-2">{e.target === "all" ? "請求書・領収書・納品書・明細" : (EXPORT_TARGET_LABEL[e.target as ExportTarget] ?? e.target)}</td>
                    <td className="tabular px-3 py-2 text-right">{formatNumber(e.documents)}</td>
                    <td className="tabular px-3 py-2 text-right">{formatNumber(e.row_count)}</td>
                    <td className="px-5 py-2 text-xs">{e.actor_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Page>
  );
}
