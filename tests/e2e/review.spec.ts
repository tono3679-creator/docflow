/**
 * 確認画面の一連の流れ：要確認の書類 → 確認事項を押して原本の位置を見る → 確認済みにする → 保存して確定 → 履歴。
 * 金額の不一致の承認、修正しただけでは確認済みにならないこと、閲覧者は操作できないこと。
 */
import { expect, test } from "@playwright/test";
import { endDemo, openDocument, startDemo } from "./helpers";

test.afterEach(async ({ page }) => {
  await endDemo(page);
});

test("要確認の書類を確認して確定する（OCR の信頼度が低い項目）", async ({ page }) => {
  await startDemo(page, "staff");
  await openDocument(page, "はやて交通");
  await expect(page.locator("h1")).toHaveText(/領収書_はやて交通_タクシー\.png/);

  // 原本（画像）が表示され、要確認の項目に印が出る
  const viewer = page.getByTestId("viewer-scroll");
  await expect(viewer.locator("[data-page='1'] img")).toBeVisible();
  await expect(viewer.locator("[data-highlight]").first()).toBeVisible();

  // 確認事項を押すと、原本のその位置が選ばれる（青い枠）
  const issues = page.getByRole("list", { name: "確認事項" }).locator("li[data-issue]");
  const count = await issues.count();
  expect(count).toBeGreaterThan(0);
  await issues.first().click();
  await expect(viewer.locator("[data-highlight].border-brand")).toBeVisible();

  // すべて確認済みにする（保存するまでは「保存すると解消します」）
  for (let i = 0; i < count; i++) {
    await page.getByRole("list", { name: "確認事項" }).getByRole("button", { name: "確認済みにする" }).first().click();
  }
  await expect(page.getByText(`未保存 ${count}件`)).toBeVisible();

  await page.getByTestId("confirm").click();
  await expect(page.getByText("確定しました")).toBeVisible();
  await expect(page.locator("[data-review-screen]").getByText("処理済み").first()).toBeVisible();

  // 履歴に「確定」が残る
  const history = page.getByTestId("history");
  await history.locator("summary").click();
  await expect(history.getByText("確定").first()).toBeVisible();
});

test("金額の不一致は赤で示し、理由を付けて承認すると確定できる", async ({ page }) => {
  await startDemo(page, "staff");
  await openDocument(page, "三和工具_0912");
  const mismatch = page.locator("[data-check-status='mismatch']");
  await expect(mismatch.first()).toBeVisible();
  await expect(page.getByTestId("confirm")).toBeDisabled();

  const issue = page.locator("li[data-issue='amount_mismatch']").first();
  await issue.getByRole("button", { name: "理由を付けて承認" }).click();
  await issue.getByLabel("承認の理由").fill("先方に確認済み（値引きのため）");
  await issue.getByRole("button", { name: "承認", exact: true }).click();
  await expect(page.getByText("承認しました")).toBeVisible();

  await expect(page.getByTestId("confirm")).toBeEnabled();
  await page.getByTestId("confirm").click();
  await expect(page.getByText("確定しました")).toBeVisible();
});

test("値を直しただけでは確認済みにならない", async ({ page }) => {
  await startDemo(page, "staff");
  await openDocument(page, "はやて交通");
  const row = page.locator("[data-field='issuer_name']");
  const input = row.locator("input, textarea").first();
  await input.fill("はやて交通株式会社（修正）");
  await expect(row.getByText("未保存")).toBeVisible();
  await page.getByTestId("save").click();
  await expect(page.getByText(/保存しました/)).toBeVisible();
  // 「確認済み」にはなっていない（確認のボタンは押されていない）
  await expect(row.getByRole("button", { name: /を確認済みにする$/ })).toHaveAttribute("aria-pressed", "false");
  await expect(row.getByText("手入力")).toBeVisible();
});

test("閲覧者は確認画面で修正・確定できない", async ({ page }) => {
  await startDemo(page, "viewer");
  await openDocument(page, "はやて交通");
  await expect(page.getByText("閲覧のみ")).toBeVisible();
  await expect(page.getByTestId("save")).toHaveCount(0);
  await expect(page.getByTestId("confirm")).toHaveCount(0);
  await expect(page.locator("[data-field='issuer_name'] input").first()).toHaveAttribute("readonly", "");
  // アップロードの画面にも入れない
  await page.goto("/upload");
  await page.waitForURL(/\/dashboard\?denied=1/);
  await expect(page.getByRole("status").getByText(/その画面は使えません/)).toBeVisible();
});
