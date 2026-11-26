import { z } from "zod";
import { asCurrentUser, getCurrentUser } from "@/lib/auth";
import { listDocuments } from "@/lib/data/documents";
import { can } from "@/lib/domain/labels";
import type { Tx } from "@/lib/db";
import { buildSheets, EXPORT_TARGET_LABEL, loadExportData, sheetToCsv, sheetsToXlsx, type ExportTarget } from "@/lib/export";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_DOCS = 2000;

const schema = z.object({
  format: z.enum(["xlsx", "csv"]),
  target: z.enum(["all", "invoice", "receipt", "delivery_note", "lines"]),
  ids: z.array(z.uuid()).max(MAX_DOCS).optional(),
  filter: z.object({
    q: z.string().max(100).optional(),
    status: z.string().max(20).optional(),
    type: z.string().max(20).optional(),
    from: z.string().max(10).optional(),
    to: z.string().max(10).optional(),
  }).optional(),
  /** true：出力せず、条件に合う件数（種別ごとの行数）だけ返す（出力の画面で、押す前に件数を見せるため） */
  preview: z.boolean().optional(),
});
type Input = z.infer<typeof schema>;

const ALL_TARGETS: ExportTarget[] = ["invoice", "receipt", "delivery_note", "lines"];

/** 出力する書類：選んだ書類、または一覧の絞り込み条件に合う書類 */
async function resolveIds(tx: Tx, input: Input): Promise<string[]> {
  if (input.ids && input.ids.length > 0) return input.ids;
  const { rows } = await listDocuments(tx, { ...input.filter, perPage: MAX_DOCS });
  return rows.map((r) => r.id);
}

/** 行が1つも無いときの説明（見出しだけのファイルは渡さない） */
function emptyMessage(input: Input): string {
  const what = input.target === "all" ? "書類" : EXPORT_TARGET_LABEL[input.target];
  if (input.ids && input.ids.length > 0) return `選んだ書類に${what}がありません`;
  if (input.filter?.status === "confirmed") return `処理済み（確定した）${what}がありません。「処理済みだけ」を外すと、確認中の書類も出力できます`;
  return `条件に合う${what}がありません`;
}

/**
 * 出力（POST・JSON）。選んだ書類（ids）か、一覧の絞り込み条件（filter）に合う書類を出す。
 * Excel は種別ごとのシート＋明細のシート。CSV は1つの種別（または明細）だけ（UTF-8 BOM 付き）。
 * 閲覧者は出力できない（データの持ち出しは担当者・管理者だけ）。出力したことは記録する。
 * 出力する行が1つも無ければ、見出しだけのファイルは渡さず、理由を返す（400）。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "ログインしてください" }, { status: 401 });
  if (!can.export(user.role)) return Response.json({ error: "出力する権限がありません" }, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return Response.json({ error: "不正な要求です" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "出力の条件が正しくありません" }, { status: 400 });
  const { format, target } = parsed.data;
  if (format === "csv" && target === "all") return Response.json({ error: "CSV は書類種別（または明細）を1つ選んでください" }, { status: 400 });

  if (parsed.data.preview) {
    const counts = await asCurrentUser(async (tx) => {
      const ids = await resolveIds(tx, parsed.data);
      const data = ids.length > 0 ? await loadExportData(tx, ids) : { docs: [], fields: [] };
      const sheets = buildSheets(data, ALL_TARGETS);
      return { documents: data.docs.length, ...Object.fromEntries(ALL_TARGETS.map((t, i) => [t, sheets[i].rows.length])) };
    });
    return Response.json(counts, { headers: { "cache-control": "no-store" } });
  }

  const out = await asCurrentUser(async (tx) => {
    const ids = await resolveIds(tx, parsed.data);
    if (ids.length === 0) return null;
    const data = await loadExportData(tx, ids);
    const targets: ExportTarget[] = target === "all" ? ALL_TARGETS : [target];
    const sheets = buildSheets(data, targets).filter((s) => target !== "all" || s.rows.length > 0);
    const rowCount = sheets.reduce((n, s) => n + s.rows.length, 0);
    if (rowCount === 0) return null;
    await tx`select record_export(${format}, ${target}, ${data.docs.map((d) => d.id)}::uuid[], ${rowCount})`;
    return { sheets, rowCount };
  });
  if (!out || out.sheets.length === 0) return Response.json({ error: emptyMessage(parsed.data) }, { status: 400 });

  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
  const name = `DocFlow_${target === "all" ? "書類" : out.sheets[0].name}_${stamp}.${format}`;
  const body = format === "xlsx" ? new Uint8Array(await sheetsToXlsx(out.sheets)) : new TextEncoder().encode(sheetToCsv(out.sheets[0]));
  return new Response(body, {
    headers: {
      "content-type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
      "x-export-rows": String(out.rowCount),
    },
  });
}
