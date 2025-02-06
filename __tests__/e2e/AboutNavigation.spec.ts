
// This e2e test uses Playwright to simulate user navigation to the About page.
import { chromium, Browser, Page } from 'playwright';

describe("About Navigation E2E Test", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    // Launch a new browser instance.
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    // Close the browser after tests.
    await browser.close();
  });

  it("should navigate to the About page when clicking on the About link", async () => {
    // Navigate to the home page.
    await page.goto("http://localhost:3000");
    // Click on the link that navigates to the About page.
    await page.click('a[href="/about"]');
    // Wait for the navigation to complete.
    await page.waitForLoadState("networkidle");
    // Assert the URL contains /about.
    const url = page.url();
    expect(url).toContain("/about");
    // Verify that the About page displays the expected header text.
    const aboutHeader = await page.waitForSelector("text=About Page");
    expect(aboutHeader).not.toBeNull();
  });
});
