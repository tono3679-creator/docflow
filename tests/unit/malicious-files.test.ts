/**
 * 悪意のある・壊れたファイルへの備え（PDF のスクリプト・添付ファイル・パスワード・破損、画像の破損・巨大画像）。
 * 実際のファイルを pdf-lib・sharp で作って確かめる。
 */
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { inspectImage } from "@/lib/extraction/image";
import { inspectPdf, PdfInspectError } from "@/lib/extraction/pdf";

async function plainPdf(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return doc;
}

describe("PDF の確認", () => {
  it("普通の PDF：ページ数を返し、スクリプト・添付なし", async () => {
    const doc = await plainPdf();
    doc.addPage([595, 842]);
    const r = await inspectPdf(await doc.save());
    expect(r).toEqual({ pageCount: 2, hasScript: false, hasAttachments: false });
  });

  it("開いたときに動くスクリプト（OpenAction の JavaScript）を見つける", async () => {
    const doc = await plainPdf();
    const js = doc.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('x')") });
    doc.catalog.set(PDFName.of("OpenAction"), doc.context.register(js));
    const r = await inspectPdf(await doc.save());
    expect(r.hasScript).toBe(true);
  });

  it("文書のスクリプト（Names の JavaScript）を見つける", async () => {
    const doc = await plainPdf();
    const js = doc.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('x')") });
    const names = doc.context.obj({ JavaScript: doc.context.obj({ Names: [PDFString.of("a"), doc.context.register(js)] }) });
    doc.catalog.set(PDFName.of("Names"), names);
    const r = await inspectPdf(await doc.save());
    expect(r.hasScript).toBe(true);
  });

  it("添付ファイルを見つける", async () => {
    const doc = await plainPdf();
    await doc.attach(new TextEncoder().encode("hello"), "note.txt", { mimeType: "text/plain" });
    const r = await inspectPdf(await doc.save());
    expect(r.hasAttachments).toBe(true);
  });

  it("壊れた PDF は「壊れている」として断る", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> broken");
    await expect(inspectPdf(bytes)).rejects.toBeInstanceOf(PdfInspectError);
  });
});

describe("画像の確認", () => {
  it("普通の PNG は大きさを返す", async () => {
    const png = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect(await inspectImage(png)).toEqual({ width: 120, height: 80 });
  });
  it("途中で切れた画像は断る", async () => {
    const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#123456" } }).png().toBuffer();
    await expect(inspectImage(png.subarray(0, 60))).rejects.toThrow(/読み込めません/);
  });
  it("画素数が大きすぎる画像（圧縮爆弾）は展開せずに断る", async () => {
    const huge = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#ffffff" } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(inspectImage(huge)).rejects.toThrow(/大きすぎます/);
  });
});
