/**
 * デモ書類（架空）を作る。
 *   npm run demo:generate   → demo/documents/*（PDF・PNG・JPEG・WebP）と demo/ground-truth.json
 * PDF は pdf-lib＋IPA ゴシックで描く（文字情報のある PDF）。画像・スキャン PDF は、その PDF を画像にしてから
 * 傾き・ノイズ・ぼかし・低解像度などを加えて作る（OCR で読む書類になる）。
 * 乱数は種を固定しているので、何度実行しても同じファイルになる。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import sharp from "sharp";
import { CATALOG, type DemoDoc, type Line } from "./catalog";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "demo/documents");

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const num = (n: number) => n.toLocaleString("ja-JP");
const jpDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Mark = { page: number; x: number; yTop: number; w: number; h: number };

class Painter {
  marks: Record<string, Mark> = {};
  constructor(public page: PDFPage, public font: PDFFont, public pageIndex: number) {}
  get H() {
    return this.page.getHeight();
  }
  width(text: string, size: number) {
    return this.font.widthOfTextAtSize(text, size);
  }
  text(text: string, x: number, yTop: number, size: number, opts: { align?: "left" | "right" | "center"; color?: [number, number, number]; mark?: string } = {}) {
    const w = this.width(text, size);
    const left = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    this.page.drawText(text, { x: left, y: this.H - yTop - size * 0.88, size, font: this.font, color: rgb(...(opts.color ?? [0.1, 0.1, 0.12])) });
    if (opts.mark) this.marks[opts.mark] = { page: this.pageIndex, x: left, yTop, w, h: size };
    return { left, w };
  }
  line(x1: number, yTop1: number, x2: number, yTop2: number, width = 0.6, gray = 0.55) {
    this.page.drawLine({ start: { x: x1, y: this.H - yTop1 }, end: { x: x2, y: this.H - yTop2 }, thickness: width, color: rgb(gray, gray, gray) });
  }
  rect(x: number, yTop: number, w: number, h: number, fill: number) {
    this.page.drawRectangle({ x, y: this.H - yTop - h, width: w, height: h, color: rgb(fill, fill, fill) });
  }
  footer() {
    this.text("このデモ書類は架空のものです（DocFlow サンプル）", this.page.getWidth() / 2, this.H - 22, 6.5, { align: "center", color: [0.6, 0.6, 0.6] });
  }
}

const TITLES = {
  invoice: { title: "請求書", number: "請求番号", date: "発行日", message: "下記のとおりご請求申し上げます。", amount: "ご請求金額" },
  delivery_note: { title: "納品書", number: "納品書番号", date: "納品日", message: "下記のとおり納品いたします。", amount: "合計金額" },
  quote: { title: "御見積書", number: "見積番号", date: "見積日", message: "下記のとおりお見積り申し上げます。", amount: "お見積金額" },
} as const;

function issuerBlock(p: Painter, d: DemoDoc, x: number, top: number) {
  if (!d.issuer) return;
  p.text(d.issuer.name, x, top, 12);
  p.text(d.issuer.postal, x, top + 18, 8.5);
  p.text(d.issuer.address, x, top + 30, 8.5);
  p.text(d.issuer.tel, x, top + 42, 8.5);
  if (d.issuer.reg) p.text(`登録番号 ${d.issuer.reg}`, x, top + 54, 8.5);
}

type Cols = { desc: number; qtyR: number; unit: number; priceR: number; amountR: number; rate?: number };

function tableHeader(p: Painter, top: number, cols: Cols, withPrices: boolean) {
  p.rect(45, top - 4, 505, 18, 0.92);
  p.text("品名", cols.desc, top, 9);
  p.text("数量", cols.qtyR, top, 9, { align: "right" });
  p.text("単位", cols.unit, top, 9);
  if (withPrices) {
    p.text("単価", cols.priceR, top, 9, { align: "right" });
    p.text("金額", cols.amountR, top, 9, { align: "right" });
  }
  if (cols.rate) p.text("税率", cols.rate, top, 9);
}

function tableRow(p: Painter, line: Line, top: number, cols: Cols, index: number, withPrices: boolean) {
  p.text(line.description, cols.desc, top, 9, { mark: `line${index}.description` });
  p.text(line.quantity, cols.qtyR, top, 9, { align: "right" });
  p.text(line.unit, cols.unit, top, 9);
  if (withPrices && line.unitPrice !== null) p.text(num(line.unitPrice), cols.priceR, top, 9, { align: "right" });
  if (withPrices && line.amount !== null) p.text(num(line.amount), cols.amountR, top, 9, { align: "right", mark: `line${index}.amount` });
  if (cols.rate && line.taxRate) p.text(`${line.taxRate}%`, cols.rate, top, 9);
  p.line(45, top + 14, 550, top + 14, 0.3, 0.8);
}

async function drawInvoiceLike(doc: PDFDocument, font: PDFFont, d: DemoDoc, marks: Record<string, Mark>) {
  const kind = d.kind === "quote" ? "quote" : d.kind === "delivery_note" ? "delivery_note" : "invoice";
  const t = TITLES[kind];
  const withPrices = d.lines.some((l) => l.unitPrice !== null);
  const hasRate = d.lines.some((l) => l.taxRate);
  const cols: Cols = hasRate ? { desc: 52, qtyR: 315, unit: 325, priceR: 405, amountR: 480, rate: 505 } : { desc: 52, qtyR: 330, unit: 342, priceR: 440, amountR: 540 };
  const perPage = d.linesPerPage ?? 20;
  const chunks: Line[][] = [];
  for (let i = 0; i < d.lines.length; i += perPage) chunks.push(d.lines.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);
  const totalPages = chunks.length + (d.extraPage ? 2 : 0);
  let index = 0;
  let pageNo = 0;
  let last: Painter | null = null;
  let lastTop = 0;
  for (const chunk of chunks) {
    const page = doc.addPage([595.28, 841.89]);
    const p = new Painter(page, font, pageNo);
    let top: number;
    if (pageNo === 0) {
      p.text(t.title, 297.6, 48, 24, { align: "center" });
      if (d.number) {
        p.text(t.number, 380, 96, 9.5);
        p.text(d.number, 450, 96, 9.5, { mark: "number" });
      }
      if (d.issueDate) {
        p.text(t.date, 380, 111, 9.5);
        p.text(jpDate(d.issueDate), 450, 111, 9.5, { mark: "date" });
      }
      p.text(`${d.recipient} 御中`, 52, 132, 14, { mark: "recipient" });
      p.line(52, 152, 280, 152, 0.8, 0.3);
      p.text(t.message, 52, 165, 9.5);
      if (d.total !== null) {
        p.rect(50, 186, 230, 28, 0.95);
        p.text(t.amount, 58, 194, 11);
        p.text(`${yen(d.total)}-`, 270, 191, 16, { align: "right", mark: "total_top" });
      }
      if (kind === "invoice" && d.dueDate) {
        p.text("お支払期限", 52, 228, 9.5);
        p.text(jpDate(d.dueDate), 130, 228, 9.5);
      }
      issuerBlock(p, d, 380, 140);
      top = 270;
    } else {
      p.text(`${t.title}（続き）`, 52, 40, 12);
      if (d.number) p.text(`${t.number} ${d.number}`, 380, 44, 9);
      top = 80;
    }
    p.text(`${pageNo + 1} / ${totalPages}`, 550, 820, 7.5, { align: "right", color: [0.5, 0.5, 0.5] });
    tableHeader(p, top, cols, withPrices);
    top += 22;
    for (const line of chunk) {
      tableRow(p, line, top, cols, index++, withPrices);
      top += 18;
    }
    p.footer();
    Object.assign(marks, Object.fromEntries(Object.entries(p.marks).map(([k, v]) => [k, v])));
    last = p;
    lastTop = top;
    pageNo++;
  }
  const p = last as Painter;
  let top = lastTop + 14;
  // 合計の欄
  const row = (label: string, value: string, mark?: string) => {
    p.text(label, 360, top, 9.5);
    p.text(value, 540, top, 9.5, { align: "right", mark });
    p.line(355, top + 15, 550, top + 15, 0.3, 0.75);
    top += 19;
  };
  if (d.subtotal !== null) row(d.taxIncluded ? "小計（税込）" : "小計", yen(d.subtotal), "subtotal");
  if (d.discount) row("値引き", `-${num(d.discount)}`);
  if (d.shipping) row("送料", yen(d.shipping));
  if (d.tax !== null && !d.breakdown) row(d.taxIncluded ? `（内消費税 ${d.taxLabelRate ?? 10}%）` : d.taxLabelRate ? `消費税（${d.taxLabelRate}%）` : "消費税", yen(d.tax), "tax");
  if (d.tax !== null && d.breakdown) row("消費税", yen(d.tax), "tax");
  if (d.total !== null) row("合計", yen(d.total), "total");
  if (d.breakdown) {
    let bt = lastTop + 14;
    for (const b of d.breakdown) {
      p.text(`${b.rate}%対象`, 52, bt, 9);
      p.text(yen(b.base), 190, bt, 9, { align: "right" });
      p.text("消費税", 215, bt, 9);
      p.text(yen(b.tax), 310, bt, 9, { align: "right" });
      bt += 16;
    }
    if (d.lines.some((l) => l.taxRate === "8")) p.text("※は軽減税率（8%）対象", 52, bt, 8);
  }
  Object.assign(marks, p.marks);
  top += 20;
  const bank = d.issuer ? `サンプル銀行 本店 普通 1234567 ${d.issuer.name}` : "";
  const writeBank = (pp: Painter, at: number) => {
    if (kind !== "invoice" || !bank) return at;
    pp.text("お振込先", 52, at, 9.5);
    pp.text(bank, 120, at, 9.5);
    return at + 26;
  };
  const writeNotes = (pp: Painter, at: number) => {
    if (!d.notes) return at;
    pp.text("備考", 52, at, 9.5);
    pp.text(d.notes, 52, at + 16, 9.5, { mark: "notes" });
    if (kind === "delivery_note") {
      pp.rect(470, at, 70, 60, 0.97);
      pp.text("受領印", 505, at + 4, 8, { align: "center" });
    }
    return at + 40;
  };
  if (d.extraPage) {
    const p2 = new Painter(doc.addPage([595.28, 841.89]), font, pageNo);
    p2.text("運行の内訳", 52, 50, 12);
    ["11月4日 東京→横浜 2便", "11月11日 東京→千葉 3便", "11月18日 東京→横浜 2便", "11月25日 東京→千葉 3便・待機 3時間"].forEach((s, i) => p2.text(s, 60, 80 + i * 18, 9.5));
    p2.text(`${pageNo + 1} / ${totalPages}`, 550, 820, 7.5, { align: "right", color: [0.5, 0.5, 0.5] });
    p2.footer();
    const p3 = new Painter(doc.addPage([595.28, 841.89]), font, pageNo + 1);
    const at = writeBank(p3, 60);
    writeNotes(p3, at + 10);
    p3.text(`${pageNo + 2} / ${totalPages}`, 550, 820, 7.5, { align: "right", color: [0.5, 0.5, 0.5] });
    p3.footer();
    Object.assign(marks, p3.marks);
  } else {
    if (d.kind === "delivery_note" && !d.notes) {
      p.rect(470, top, 70, 60, 0.97);
      p.text("受領印", 505, top + 4, 8, { align: "center" });
    }
    const at = writeBank(p, top);
    writeNotes(p, at);
    Object.assign(marks, p.marks);
  }
}

function drawFormalReceipt(doc: PDFDocument, font: PDFFont, d: DemoDoc, marks: Record<string, Mark>) {
  const page = doc.addPage([595.28, 420]);
  const p = new Painter(page, font, 0);
  p.text("領収書", 297.6, 28, 22, { align: "center" });
  if (d.number) p.text(`No. ${d.number}`, 545, 68, 9, { align: "right", mark: "number" });
  if (d.issueDate) {
    p.text("発行日", 420, 84, 9);
    p.text(jpDate(d.issueDate), 545, 84, 9, { align: "right", mark: "date" });
  }
  p.text(`${d.recipient} 様`, 50, 84, 14, { mark: "recipient" });
  p.line(50, 104, 300, 104, 0.8, 0.3);
  p.rect(110, 120, 375, 36, 0.95);
  p.text("領収金額", 130, 131, 11);
  p.text(`${yen(d.total as number)}-`, 465, 126, 20, { align: "right", mark: "total" });
  if (d.purpose) p.text(`但し ${d.purpose}`, 130, 172, 10.5, { mark: "purpose" });
  p.text("上記正に領収いたしました。", 130, 192, 9.5);
  const b = d.breakdown?.[0];
  if (b) {
    p.text("内訳", 50, 236, 9);
    p.text("税抜金額", 50, 252, 9);
    p.text(yen(b.base), 200, 252, 9, { align: "right", mark: "subtotal" });
    p.text(`消費税額（${b.rate}%）`, 50, 268, 9);
    p.text(yen(b.tax), 200, 268, 9, { align: "right", mark: "tax" });
  }
  if (d.paymentMethod) {
    p.text("お支払方法", 50, 290, 9);
    p.text(d.paymentMethod, 120, 290, 9);
  }
  if (d.issuer) issuerBlock(p, d, 360, 236);
  else {
    // 発行元の記載なし（印影だけ）
    p.page.drawCircle({ x: 470, y: 420 - 270, size: 22, borderColor: rgb(0.8, 0.25, 0.25), borderWidth: 1.5 });
    p.text("印", 470, 262, 14, { align: "center", color: [0.8, 0.25, 0.25] });
  }
  p.footer();
  Object.assign(marks, p.marks);
}

function drawShopReceipt(doc: PDFDocument, font: PDFFont, d: DemoDoc, marks: Record<string, Mark>) {
  const page = doc.addPage([226, 560]);
  const p = new Painter(page, font, 0);
  const c = 113;
  const issuer = d.issuer as NonNullable<DemoDoc["issuer"]>;
  p.text(`${issuer.name} 本町店`, c, 24, 12, { align: "center" });
  p.text(issuer.address, c, 44, 7.5, { align: "center" });
  p.text(issuer.tel, c, 56, 7.5, { align: "center" });
  if (issuer.reg) p.text(`登録番号 ${issuer.reg}`, c, 68, 7.5, { align: "center" });
  p.text("領収書", c, 88, 13, { align: "center" });
  p.text(`${jpDate(d.issueDate as string)} 12:31`, 16, 112, 8, { mark: "date" });
  p.text(`No.${d.number}`, 210, 112, 8, { align: "right" });
  let top = 132;
  p.text("品名", 16, top, 8);
  p.text("数量", 150, top, 8, { align: "right" });
  p.text("金額", 210, top, 8, { align: "right" });
  p.line(16, top + 13, 210, top + 13, 0.4, 0.5);
  top += 18;
  d.lines.forEach((l, i) => {
    p.text(l.taxRate === "8" ? l.description.replace(/^※\s?/, "※") : l.description, 16, top, 8, { mark: `line${i}.description` });
    p.text(l.quantity, 150, top, 8, { align: "right" });
    p.text(yen(l.amount as number), 210, top, 8, { align: "right", mark: `line${i}.amount` });
    top += 15;
  });
  p.line(16, top, 210, top, 0.4, 0.5);
  top += 8;
  const row = (label: string, value: string, size = 8, mark?: string) => {
    p.text(label, 16, top, size);
    p.text(value, 210, top, size, { align: "right", mark });
    top += size + 7;
  };
  row("小計", yen(d.subtotal as number), 8, "subtotal");
  for (const b of d.breakdown ?? []) {
    p.text(`${b.rate}%対象`, 16, top, 8);
    p.text(yen(b.base), 120, top, 8, { align: "right" });
    p.text("内税", 140, top, 8);
    p.text(yen(b.tax), 210, top, 8, { align: "right" });
    top += 15;
  }
  row("内消費税等", yen(d.tax as number), 8, "tax");
  row("合計", yen(d.total as number), 11, "total");
  row("お預かり", yen(6000));
  row("お釣り", yen(6000 - (d.total as number)));
  p.text(`お支払方法 ${d.paymentMethod}`, 16, top + 4, 8);
  p.text("※印は軽減税率（8%）対象商品", 16, top + 22, 7);
  p.text("このデモ書類は架空のものです", c, 540, 6, { align: "center", color: [0.6, 0.6, 0.6] });
  Object.assign(marks, p.marks);
}

async function renderPdf(bytes: Uint8Array, scale: number): Promise<Buffer[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
  const pdf = await task.promise;
  const out: Buffer[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, canvas: canvas as unknown as HTMLCanvasElement, viewport: vp }).promise;
    out.push(canvas.toBuffer("image/png"));
  }
  await task.destroy();
  return out;
}

async function noise(width: number, height: number, seed: number, strength: number): Promise<Buffer> {
  const r = rng(seed);
  const buf = Buffer.alloc(width * height);
  for (let i = 0; i < buf.length; i++) buf[i] = 255 - Math.floor(r() * r() * strength);
  return sharp(buf, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function scanLike(png: Buffer, seed: number, opts: { rotate: number; blur: number; noise: number }) {
  const base = sharp(png).grayscale();
  const meta = await sharp(png).metadata();
  const n = await noise(meta.width as number, meta.height as number, seed, opts.noise);
  const composed = await base.composite([{ input: n, blend: "multiply" }]).png().toBuffer();
  let s = sharp(composed).rotate(opts.rotate, { background: "#ffffff" });
  if (opts.blur > 0.3) s = s.blur(opts.blur);
  return s.linear(1.08, -10).png().toBuffer();
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const fontBytes = await readFile(path.join(ROOT, "assets/fonts/ipag.ttf"));
  const files = new Map<string, Buffer>();
  const truth: Record<string, unknown>[] = [];

  for (const d of CATALOG) {
    let bytes: Buffer;
    if (d.copyOf) {
      bytes = files.get(d.copyOf) as Buffer;
    } else {
      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      doc.setTitle(d.filename.replace(/\.[a-z]+$/, ""));
      doc.setProducer("DocFlow demo generator");
      doc.setCreationDate(new Date("2026-11-20T00:00:00Z"));
      doc.setModificationDate(new Date("2026-11-20T00:00:00Z"));
      const font = await doc.embedFont(fontBytes, { subset: true });
      const marks: Record<string, Mark> = {};
      if (d.kind === "receipt") (d.style === "shop" ? drawShopReceipt : drawFormalReceipt)(doc, font, d, marks);
      else await drawInvoiceLike(doc, font, d, marks);
      const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
      const seed = d.id.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
      switch (d.render) {
        case "pdf":
          bytes = pdf;
          break;
        case "png_clean":
          bytes = (await renderPdf(pdf, 2))[0];
          break;
        case "png_scan":
          bytes = await scanLike((await renderPdf(pdf, 2.2))[0], seed, { rotate: 0.4, blur: 0.5, noise: 70 });
          break;
        case "png_blur_number": {
          const scale = 2.2;
          let png = await scanLike((await renderPdf(pdf, scale))[0], seed, { rotate: 0, blur: 0.4, noise: 60 });
          const m = marks.number;
          const left = Math.max(0, Math.floor(m.x * scale) - 4);
          const top = Math.max(0, Math.floor(m.yTop * scale) - 4);
          const width = Math.ceil(m.w * scale) + 8;
          const height = Math.ceil(m.h * 1.2 * scale) + 8;
          const region = await sharp(png).extract({ left, top, width, height }).blur(2.1).png().toBuffer();
          png = await sharp(png).composite([{ input: region, left, top }]).png().toBuffer();
          bytes = png;
          break;
        }
        case "jpeg_scan": {
          // 複合機でスキャンした JPEG（標準的な画質）
          const png = await scanLike((await renderPdf(pdf, 2))[0], seed, { rotate: 0.3, blur: 0.3, noise: 40 });
          bytes = await sharp(png).jpeg({ quality: 82 }).toBuffer();
          break;
        }
        case "jpeg_low": {
          const png = (await renderPdf(pdf, 1.25))[0];
          bytes = await sharp(png).blur(0.45).jpeg({ quality: 55 }).toBuffer();
          break;
        }
        case "webp_photo": {
          const png = (await renderPdf(pdf, 2))[0];
          bytes = await sharp(png).rotate(-0.5, { background: "#f4f1ea" }).modulate({ brightness: 0.97 }).tint({ r: 250, g: 244, b: 232 }).webp({ quality: 74 }).toBuffer();
          break;
        }
        case "jpeg_unreadable": {
          const png = (await renderPdf(pdf, 0.9))[0];
          bytes = await sharp(png).blur(4.2).modulate({ brightness: 1.25 }).jpeg({ quality: 35 }).toBuffer();
          break;
        }
        case "scan_pdf": {
          const pages = await renderPdf(pdf, 2.2);
          const scanned = await PDFDocument.create();
          scanned.setProducer("DocFlow demo scanner");
          scanned.setCreationDate(new Date("2026-11-20T00:00:00Z"));
          scanned.setModificationDate(new Date("2026-11-20T00:00:00Z"));
          for (const [i, pg] of pages.entries()) {
            const jpg = await sharp(await scanLike(pg, seed + i, { rotate: 0.3, blur: 0.5, noise: 60 })).jpeg({ quality: 72 }).toBuffer();
            const img = await scanned.embedJpg(jpg);
            const page = scanned.addPage([595.28, 841.89]);
            page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
          }
          bytes = Buffer.from(await scanned.save({ useObjectStreams: false }));
          break;
        }
      }
    }
    files.set(d.id, bytes);
    await writeFile(path.join(OUT, d.filename), bytes);

    // 正解（書類に印字した値）
    const kind = d.kind === "quote" ? "unknown" : d.kind;
    const f: Record<string, string | null> = {};
    if (kind !== "unknown") {
      f.issuer_name = d.issuer ? (d.style === "shop" ? `${d.issuer.name} 本町店` : d.issuer.name) : null;
      if (d.style !== "shop") f.recipient_name = d.recipient || null;
      f[kind === "invoice" ? "invoice_number" : kind === "receipt" ? "receipt_number" : "delivery_number"] = d.number;
      f[kind === "delivery_note" ? "delivery_date" : "issue_date"] = d.issueDate;
      if (kind === "invoice") f.due_date = d.dueDate ?? null;
      if (d.issuer?.reg && kind !== "delivery_note") f.registration_number = d.issuer.reg;
      f.total_amount = d.total === null ? null : String(d.total);
      if (kind === "receipt" && d.style !== "shop") {
        f.subtotal = d.breakdown ? String(d.breakdown[0].base) : null;
        f.tax_amount = d.breakdown ? String(d.breakdown[0].tax) : null;
        f.purpose = d.purpose ?? null;
        f.payment_method = d.paymentMethod ?? null;
      } else {
        f.subtotal = d.subtotal === null ? null : String(d.subtotal);
        f.tax_amount = d.tax === null ? null : String(d.tax);
      }
      if (kind === "receipt" && d.style === "shop") f.payment_method = d.paymentMethod ?? null;
      for (const b of d.breakdown ?? []) {
        if (kind === "receipt" && d.style !== "shop") break;
        f[`tax_${b.rate}_base`] = String(b.base);
        f[`tax_${b.rate}`] = String(b.tax);
      }
      if (d.discount) f.discount = String(-d.discount);
      if (d.shipping) f.shipping_fee = String(d.shipping);
    }
    truth.push({
      id: d.id,
      filename: d.filename,
      pattern: d.pattern,
      render: d.render,
      document_type: kind,
      fields: f,
      lines: d.lines.map((l) => ({ description: l.description.replace(/^※\s?/, ""), quantity: l.quantity, unit: d.style === "shop" ? null : l.unit, unit_price: d.style === "shop" || l.unitPrice === null ? null : String(l.unitPrice), amount: l.amount === null ? null : String(l.amount) })),
      confirm_days_ago: d.confirmDaysAgo ?? null,
      copy_of: d.copyOf ?? null,
    });
    console.log(`${d.id} ${d.filename} (${(bytes.length / 1024).toFixed(0)}KB)`);
  }
  await writeFile(path.join(ROOT, "demo/ground-truth.json"), JSON.stringify(truth, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
