import { expect, test } from "@playwright/test"

test.describe("Basic E2E", () => {
  test("can visit homepage and see some text", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator("h1")).toContainText("Home Page")
  })
})
