import { expect, type Page } from "@playwright/test";

export type Persona = "admin" | "staff" | "viewer";
const TITLE: Record<Persona, string> = { admin: "管理者", staff: "担当者", viewer: "閲覧者" };

/** ログイン画面の「〇〇で試す」から、このテスト専用のデモ組織を作って入る */
export async function startDemo(page: Page, persona: Persona) {
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(`${TITLE[persona]}で試す`) }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  await expect(page.getByRole("note").getByText("デモ", { exact: true })).toBeVisible();
}

/** 公開環境で実行したときに、作ったデモ組織を片付ける（画面の「デモを終了する」） */
export async function endDemo(page: Page) {
  if (!process.env.E2E_BASE_URL) return;
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "ユーザーメニュー" }).click();
  await page.getByRole("menuitem", { name: "デモを終了する" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/dashboard"));
}

/** ファイル名の一部で書類を探して開く */
export async function openDocument(page: Page, filenamePart: string) {
  await page.goto(`/documents?q=${encodeURIComponent(filenamePart)}`);
  // 検索で1件に絞ってから開く（PC は表、スマートフォンはカード）
  await page.locator('a[href^="/documents/"]:visible').first().click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}/);
  await expect(page.locator("[data-review-screen]")).toBeVisible();
}

/** ページが横にはみ出していないこと（スマートフォン） */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "横にはみ出している").toBeLessThanOrEqual(client + 1);
}
