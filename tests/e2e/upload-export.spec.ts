/**
 * アップロード → 読み取り（PDF の文字・画像の OCR）→ 一覧、受け付けないファイル、同じファイルの検出。
 * 出力：Excel（種別ごとのシート＋明細）と CSV（BOM 付き UTF-8）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { endDemo, startDemo } from "./helpers";

const SAMPLES = path.join(process.cwd(), "public/samples");

test.afterEach(async ({ page }) => {
  await endDemo(page);
});

test("書類をアップロードすると読み取りが終わり、同じファイルは知らせる。偽の PDF は受け付けない", async ({ page }) => {
  test.setTimeout(150_000);
  await startDemo(page, "admin");
  await page.goto("/upload");
  const file = async (name: string, mimeType: string) => ({ name, mimeType, buffer: await readFile(path.join(SAMPLES, name)) });
  await page.getByTestId("upload-input").setInputFiles([
    await file("sample-invoice.pdf", "application/pdf"),
    await file("sample-receipt.png", "image/png"),
    { name: "偽物.pdf", mimeType: "application/pdf", buffer: Buffer.from("これは PDF ではありません") },
  ]);
  const list = page.getByRole("region", { name: "アップロードした書類" });
  const fake = list.locator("li").filter({ hasText: "偽物.pdf" });
  await expect(fake.getByLabel("受付不可")).toBeVisible();

  // 読み取りが終わる（PDF は文字情報、PNG は OCR）
  await expect(list.getByText("処理 2 / 2")).toBeVisible({ timeout: 120_000 });
  const invoice = list.locator("li").filter({ hasText: "sample-invoice.pdf" });
  await expect(invoice.getByText("請求書")).toBeVisible();
  // 見本の書類と同じファイルなので、登録済みであることを知らせる（自動では消さない）
  await expect(invoice.getByText(/同じファイルが登録済み/)).toBeVisible();
  const receipt = list.locator("li").filter({ hasText: "sample-receipt.png" });
  await expect(receipt.getByText("領収書")).toBeVisible();

  // 読み取った書類を開ける
  await invoice.getByRole("link").click();
  await expect(page.locator("[data-review-screen] h1")).toHaveText("sample-invoice.pdf");
  await expect(page.getByTestId("duplicate-candidate").first()).toBeVisible();
});

test("処理済みの書類を Excel と CSV に出力する", async ({ page }) => {
  await startDemo(page, "staff");
  await page.goto("/documents?status=confirmed");
  await page.getByRole("button", { name: "出力" }).click();
  const dialog = page.getByRole("dialog", { name: "出力" });

  const [xlsx] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "出力する" }).click()]);
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await xlsx.path())!);
  const names = book.worksheets.map((w) => w.name);
  expect(names).toEqual(expect.arrayContaining(["請求書", "領収書", "納品書", "明細"]));
  const invoiceSheet = book.getWorksheet("請求書")!;
  expect(invoiceSheet.rowCount).toBeGreaterThan(1);
  expect(invoiceSheet.getRow(1).values).toEqual(expect.arrayContaining(["発行元", "合計"]));

  await page.getByRole("button", { name: "出力" }).click();
  await dialog.getByRole("radio", { name: /CSV/ }).click();
  await dialog.getByRole("radio", { name: /請求書/ }).click();
  const [csv] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "出力する" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  const bytes = await readFile((await csv.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString("utf8");
  const rows = text.split(/\r?\n/).filter(Boolean);
  expect(rows[0]).toContain("発行元");
  // 見出しだけでなく、処理済みの請求書の行が入っている（発行元・合計の列に値がある）
  expect(rows.length).toBeGreaterThan(1);
  const header = rows[0].split(",");
  const first = rows[1].split(",");
  expect(first[header.indexOf("状態")]).toBe("処理済み");
  expect(first[header.indexOf("発行元")]).not.toBe("");
  expect(Number(first[header.indexOf("合計")])).toBeGreaterThan(0);
});

test("出力する行が無い内容は選べず、理由を示す（見出しだけのファイルを渡さない）", async ({ page }) => {
  await startDemo(page, "staff");
  await page.goto("/documents?type=receipt");
  await page.getByRole("checkbox", { name: /領収書_.*を選択/ }).first().check();
  await page.getByRole("button", { name: "出力" }).click();
  const dialog = page.getByRole("dialog", { name: "出力" });
  await dialog.getByRole("radio", { name: /CSV/ }).click();
  await dialog.getByRole("radio", { name: /請求書/ }).click();
  await expect(dialog.getByRole("radio", { name: /請求書/ })).toContainText("0件");
  await expect(dialog.getByTestId("export-empty")).toContainText("選んだ書類に請求書がありません");
  await expect(dialog.getByRole("button", { name: "出力する" })).toBeDisabled();
  // 領収書なら出せる
  await dialog.getByRole("radio", { name: /領収書/ }).click();
  await expect(dialog.getByRole("radio", { name: /領収書/ })).toContainText("1件");
  await expect(dialog.getByRole("button", { name: "出力する" })).toBeEnabled();
  // API を直接呼んでも、見出しだけの CSV は返さない
  const href = await page.locator('a[href^="/documents/"]').filter({ hasText: /領収書_/ }).first().getAttribute("href");
  const id = href!.split("/").pop()!.split("?")[0];
  const res = await page.request.post("/api/export", { data: { format: "csv", target: "invoice", ids: [id] } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("選んだ書類に請求書がありません");
});
