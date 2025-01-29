import { expect, test } from "@playwright/test"

test.describe("Basic E2E", () => {
  test("can visit homepage and see some text", async ({ page }) => {
    await page.goto("/")
    // Suppose your Next.js homepage shows "Home Page"
    await expect(page.locator("h1")).toContainText("Home Page")
  })
})
