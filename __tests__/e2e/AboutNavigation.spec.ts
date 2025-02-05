
import { test, expect } from "@playwright/test";

test("should navigate to About page from Home page", async ({ page }) => {
  await page.goto("/");
  await page.click("text=About");
  await expect(page).toHaveURL("/about");
  // Updated expected text from "About Page" to "hello world!!!"
  await expect(page.getByText("hello world!!!")).toBeVisible();
});
      