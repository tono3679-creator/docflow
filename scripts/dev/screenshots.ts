/**
 * 画面のスクリーンショットを撮る（紹介ページの画像と README 用）。
 * 先に `npm run dev`（または build → start）でアプリを起動してから実行する。デモを1つ作って撮り、最後に片付ける。
 *   npm run screenshots              → public/screens/ と docs/screenshots/ に保存
 *   BASE_URL=https://… npm run screenshots
 */
import { mkdirSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
/** 紹介ページの最初の画像：スキャンした請求書（黄色＝信頼度が低い。金額が合わない確認事項があれば選ぶ） */
const HERO_DOC = "大和梱包資材_スキャン";
const MOBILE_DOC = "知恵の森書店";

async function start(browser: Browser, mobile: boolean, persona: "管理者" | "担当者" = "担当者"): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: new RegExp(`${persona}で試す`) }).click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
  return { ctx, page };
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  // Next.js の開発用インジケーター・通知を隠す
  await page.addStyleTag({ content: "nextjs-portal,[data-sonner-toaster]{display:none!important}" });
  await page.waitForTimeout(400);
}

async function save(page: Page, files: string[], fullPage = false) {
  await settle(page);
  for (const file of files) {
    await page.screenshot({ path: file, fullPage });
    console.log("saved", file);
  }
}

async function shot(page: Page, path: string, files: string[], fullPage = false) {
  await page.goto(`${BASE}${path}`);
  await save(page, files, fullPage);
}

async function openDocument(page: Page, part: string, mobile = false) {
  await page.goto(`${BASE}/documents?q=${encodeURIComponent(part)}`);
  await page.locator('a[href^="/documents/"]:visible').first().click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}/);
  await page.locator("[data-review-screen]").waitFor();
  // スマートフォンは「項目」のタブから始まる（原本は表示したときに描く）
  if (!mobile) await waitOriginal(page);
}

/** 原本の読み込みを待つ */
async function waitOriginal(page: Page) {
  await page.locator("[data-testid='viewer-scroll'] [data-page='1'] canvas, [data-testid='viewer-scroll'] [data-page='1'] img").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(800);
}

async function endDemo(page: Page) {
  await page.goto(`${BASE}/dashboard`);
  await page.getByRole("button", { name: "ユーザーメニュー" }).click();
  await page.getByRole("menuitem", { name: "デモを終了する" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/dashboard"));
}

async function main() {
  mkdirSync("public/screens", { recursive: true });
  mkdirSync("docs/screenshots", { recursive: true });
  // 日付の入力欄なども日本語の表示にする
  const browser = await chromium.launch({ args: ["--lang=ja-JP"], env: { ...process.env, LANG: "ja_JP.UTF-8" } });
  try {
    // 紹介ページ（ログイン前）
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "ja-JP" });
      const page = await ctx.newPage();
      await shot(page, "/", ["docs/screenshots/landing.png"]);
      await ctx.close();
    }

    // PC
    {
      const { ctx, page } = await start(browser, false);
      await shot(page, "/dashboard", ["docs/screenshots/dashboard.png"]);
      await shot(page, "/documents", ["docs/screenshots/documents.png"]);
      await openDocument(page, HERO_DOC);
      // 金額が合わない確認事項を選ぶ（原本の位置が青い枠で示される）
      const mismatch = page.locator("li[data-issue='amount_mismatch']").first();
      if (await mismatch.count()) await mismatch.click();
      await page.waitForTimeout(600);
      await save(page, ["public/screens/review.png", "docs/screenshots/review.png"]);
      await page.locator("[data-review-screen] [aria-label='金額の照合']").scrollIntoViewIfNeeded();
      await save(page, ["docs/screenshots/review-checks.png"]);
      await shot(page, "/upload", ["docs/screenshots/upload.png"]);
      await shot(page, "/history", ["docs/screenshots/history.png"]);
      await endDemo(page);
      await ctx.close();
    }
    {
      const { ctx, page } = await start(browser, false, "管理者");
      await shot(page, "/settings", ["docs/screenshots/settings.png"], true);
      await endDemo(page);
      await ctx.close();
    }

    // スマートフォン
    {
      const { ctx, page } = await start(browser, true);
      await openDocument(page, MOBILE_DOC, true);
      await save(page, ["docs/screenshots/mobile-fields.png"]);
      await page.getByRole("tab", { name: "原本" }).click();
      await waitOriginal(page);
      await save(page, ["public/screens/mobile-review.png", "docs/screenshots/mobile-review.png"]);
      await shot(page, "/dashboard", ["docs/screenshots/mobile-dashboard.png"]);
      await endDemo(page);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
