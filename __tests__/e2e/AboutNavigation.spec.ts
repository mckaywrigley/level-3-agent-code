import { test, expect } from "@playwright/test";

test("should navigate to About page from Home page", async ({ page }) => {
  await page.goto("/");
  await page.click("text=About");
  await expect(page).toHaveURL("/about");
  await expect(page.getByText("About Page")).toBeVisible();
});