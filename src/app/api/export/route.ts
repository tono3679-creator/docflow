import { z } from "zod";
import { asCurrentUser, getCurrentUser } from "@/lib/auth";
import { listDocuments } from "@/lib/data/documents";
import { can } from "@/lib/domain/labels";
import { buildSheets, loadExportData, sheetToCsv, sheetsToXlsx, type ExportTarget } from "@/lib/export";

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
});

/**
 * 出力（POST・JSON）。選んだ書類（ids）か、一覧の絞り込み条件（filter）に合う書類を出す。
 * Excel は種別ごとのシート＋明細のシート。CSV は1つの種別（または明細）だけ（UTF-8 BOM 付き）。
 * 閲覧者は出力できない（データの持ち出しは担当者・管理者だけ）。出力したことは記録する。
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

  const out = await asCurrentUser(async (tx) => {
    let ids = parsed.data.ids ?? [];
    if (ids.length === 0) {
      const { rows } = await listDocuments(tx, { ...parsed.data.filter, perPage: MAX_DOCS });
      ids = rows.map((r) => r.id);
    }
    if (ids.length === 0) return null;
    const data = await loadExportData(tx, ids);
    const targets: ExportTarget[] = target === "all" ? ["invoice", "receipt", "delivery_note", "lines"] : [target];
    const sheets = buildSheets(data, targets).filter((s) => target !== "all" || s.rows.length > 0);
    const rowCount = sheets.reduce((n, s) => n + s.rows.length, 0);
    await tx`select record_export(${format}, ${target}, ${data.docs.map((d) => d.id)}::uuid[], ${rowCount})`;
    return { sheets, rowCount };
  });
  if (!out || out.sheets.length === 0) return Response.json({ error: "出力する書類がありません" }, { status: 400 });

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
