/** 紹介ページ：課題・解決・導入効果（架空企業のシミュレーションと明記）・精度は実測値 */
import { expect, test } from "@playwright/test";

test("紹介ページに導入効果のシミュレーションと注意書きがある @both", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("架空企業のシミュレーション").first()).toBeVisible();
  await expect(page.getByText(/204/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /デモを試す/ }).first()).toBeVisible();
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client + 1);
});

test("ログインしていないと業務の画面には入れない", async ({ page }) => {
  await page.goto("/documents");
  await page.waitForURL(/\/login/);
  const res = await page.request.get("/api/export", { failOnStatusCode: false });
  expect([401, 403, 405]).toContain(res.status());
});
