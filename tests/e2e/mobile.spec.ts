/** スマートフォン：主な画面が横にはみ出さない・確認画面は「原本／項目」のタブで切り替える */
import { expect, test } from "@playwright/test";
import { endDemo, expectNoHorizontalOverflow, openDocument, startDemo } from "./helpers";

test.afterEach(async ({ page }) => {
  await endDemo(page);
});

test("スマートフォンで書類を確認する @mobile", async ({ page }) => {
  await startDemo(page, "staff");
  await expectNoHorizontalOverflow(page);
  for (const path of ["/documents", "/upload", "/history"]) {
    await page.goto(path);
    await expectNoHorizontalOverflow(page);
  }
  await openDocument(page, "はやて交通");
  await expectNoHorizontalOverflow(page);
  const tabs = page.getByRole("tablist", { name: "表示の切り替え" });
  await expect(tabs).toBeVisible();

  // 項目のタブ（確認事項・項目）
  await tabs.getByRole("tab", { name: /項目/ }).click();
  await expect(page.getByTestId("review-pane")).toBeVisible();
  await expect(page.getByTestId("viewer-scroll")).toBeHidden();
  // 「原本で見る」で原本のタブに切り替わり、その位置が選ばれる
  await page.locator("[data-field='total_amount']").getByRole("button", { name: /原本で見る/ }).click();
  await expect(page.getByTestId("viewer-scroll")).toBeVisible();
  await expect(page.getByTestId("viewer-scroll").locator("[data-highlight].border-brand")).toBeVisible();

  // 操作のボタンは画面の下に固定され、押せる
  await expect(page.getByTestId("confirm")).toBeInViewport();
  await expect(page.getByTestId("save")).toBeInViewport();
});
