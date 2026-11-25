/** 出力（CSV・Excel）と、アップロードされたファイルの形式の確認 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildSheets, sheetToCsv, sheetsToXlsx, type ExportData } from "@/lib/export";
import { basicFileCheck, detectFileType, safeFilename } from "@/lib/extraction/file-type";

const data: ExportData = {
  docs: [
    { id: "d1", filename: "請求書.pdf", document_type: "invoice", status: "confirmed", confirmed_at: new Date("2026-11-20T05:00:00Z"), confirmed_by_name: "佐藤 健" },
    { id: "d2", filename: "=HYPERLINK(\"http://x\").pdf", document_type: "receipt", status: "needs_review", confirmed_at: null, confirmed_by_name: null },
  ],
  fields: [
    { document_id: "d1", field_key: "issuer_name", line_index: null, value: "直したあと", confirmed_value: "株式会社テスト" },
    { document_id: "d1", field_key: "total_amount", line_index: null, value: "11000", confirmed_value: "11000" },
    { document_id: "d1", field_key: "issue_date", line_index: null, value: "2026-11-01", confirmed_value: "2026-11-01" },
    { document_id: "d1", field_key: "description", line_index: 0, value: "作業費", confirmed_value: "作業費" },
    { document_id: "d1", field_key: "quantity", line_index: 0, value: "2.5", confirmed_value: "2.5" },
    { document_id: "d1", field_key: "tax_rate", line_index: 0, value: "8", confirmed_value: "8" },
    { document_id: "d2", field_key: "issuer_name", line_index: null, value: "+cmd|' /C calc'!A0", confirmed_value: null },
    { document_id: "d2", field_key: "total_amount", line_index: null, value: "1l0", confirmed_value: null },
  ],
};

describe("出力", () => {
  const sheets = buildSheets(data, ["invoice", "receipt", "lines"]);
  it("書類種別ごとに列を分け、明細は別のシートにする", () => {
    expect(sheets.map((s) => s.name)).toEqual(["請求書", "領収書", "明細"]);
    expect(sheets[0].header).toContain("請求番号");
    expect(sheets[1].header).toContain("領収金額");
    expect(sheets[2].rows).toHaveLength(1);
  });
  it("確定済みの書類は確定したときの値、金額は数値・日付は YYYY-MM-DD・税率は表示名", () => {
    const row = sheets[0].rows[0];
    const col = (name: string) => row[sheets[0].header.indexOf(name)];
    expect(col("発行元")).toBe("株式会社テスト");
    expect(col("合計")).toBe(11000);
    expect(col("発行日")).toBe("2026-11-01");
    expect(col("確定者")).toBe("佐藤 健");
    const line = sheets[2].rows[0];
    expect(line[sheets[2].header.indexOf("数量")]).toBe(2.5);
    expect(line[sheets[2].header.indexOf("税率")]).toBe("8%");
  });
  it("解釈できない金額は文字のまま出す（数値に作り替えない）", () => {
    expect(sheets[1].rows[0][sheets[1].header.indexOf("領収金額")]).toBe("1l0");
  });
  it("CSV：BOM 付き・CRLF・数式として動く文字は ' を付けて無害化", () => {
    const csv = sheetToCsv(sheets[1]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain(`"'=HYPERLINK(""http://x"").pdf"`);
    expect(csv).toContain(`'+cmd|' /C calc'!A0`);
  });
  it("Excel：同じ無害化・見出しの固定・フィルター", async () => {
    const buf = await sheetsToXlsx(sheets);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("領収書")!;
    const values = ws.getRow(2).values as unknown[];
    expect(values).toContain("'=HYPERLINK(\"http://x\").pdf");
    expect(values).toContain("'+cmd|' /C calc'!A0");
    expect(values.some((v) => typeof v === "object" && v !== null && "formula" in (v as object))).toBe(false);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    expect(wb.getWorksheet("請求書")!.getRow(2).getCell(wb.getWorksheet("請求書")!.getRow(1).values!.length as number).value).not.toBeUndefined();
  });
});

describe("ファイルの形式の確認（拡張子・MIME ではなく中身で判定）", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n...");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const exe = new TextEncoder().encode("MZ\x90\x00 this is not a pdf");
  const check = (bytes: Uint8Array, filename: string, declaredMime = "") => basicFileCheck({ bytes, filename, declaredMime, maxBytes: 1024 });

  it("PDF・PNG・JPEG を判定する", () => {
    expect(detectFileType(pdf)).toBe("pdf");
    expect(detectFileType(png)).toBe("png");
    expect(detectFileType(jpeg)).toBe("jpeg");
    expect(check(pdf, "a.pdf", "application/pdf")).toEqual({ ok: true, fileType: "pdf" });
    expect(check(jpeg, "a.JPG", "image/jpg")).toEqual({ ok: true, fileType: "jpeg" });
  });
  it("拡張子を偽った実行ファイル・中身と拡張子の食い違い・MIME の食い違い・空・大きすぎを断る", () => {
    expect(check(exe, "invoice.pdf").ok).toBe(false);
    expect(check(png, "invoice.pdf").ok).toBe(false);
    expect(check(pdf, "a.pdf", "image/png").ok).toBe(false);
    expect(check(new Uint8Array(), "a.pdf").ok).toBe(false);
    expect(check(new Uint8Array(2048).fill(0x25), "a.pdf").ok).toBe(false);
  });
  it("ファイル名からパスや制御文字を除く", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Users\\a\\請求書.pdf")).toBe("請求書.pdf");
    expect(safeFilename("a\u0000b<>.pdf")).toBe("a_b__.pdf");
  });
});
