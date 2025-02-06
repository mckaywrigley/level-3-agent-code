import { chromium, Browser, Page } from 'playwright';

describe("About Navigation E2E Test", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("should navigate to the About page when clicking on the About link", async () => {
    await page.goto("http://localhost:3000");
    await page.click('a[href="/about"]');
    await page.waitForLoadState("networkidle");
    const url = page.url();
    expect(url).toContain("/about");
    const aboutHeader = await page.waitForSelector("text=This is the About Page");
    expect(aboutHeader).not.toBeNull();
  });
});
