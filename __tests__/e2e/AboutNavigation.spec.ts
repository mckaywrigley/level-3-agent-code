
import { test, expect } from '@playwright/test';

// End-to-end test for verifying navigation to the About page.
test('should navigate to About Page successfully', async ({ page }) => {
  // Go to the application's homepage.
  await page.goto('http://localhost:3000');

  // Click the link that routes to the About page.
  await page.click('a[href="/about"]');

  // Wait for About page content to load and validate the heading.
  const aboutHeading = page.locator('h1');
  await expect(aboutHeading).toHaveText('About Page');
});
