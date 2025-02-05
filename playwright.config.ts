/*
<ai_context>
This file configures Playwright, a powerful end-to-end testing framework.
It defines how our tests will run, what browsers to use, and various testing behaviors.
</ai_context>
*/

import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  // The directory where our end-to-end tests live
  testDir: "__tests__/e2e",

  // Run all tests in parallel for speed
  fullyParallel: true,

  // In CI, forbid the usage of test.only
  forbidOnly: !!process.env.CI,

  // Retry failing tests to reduce flakiness, especially in CI
  retries: process.env.CI ? 2 : 0,

  // Limit concurrency in CI for resource reasons
  workers: process.env.CI ? 1 : undefined,

  // Configure how results are reported
  reporter: [
    ["dot"],
    ["json", { outputFile: "reports/playwright/report.json" }]
  ],

  // Global test configuration
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry" // Collect trace only when retrying failed tests
  },

  // Define the browsers and environments to test in
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      outputDir: "reports/playwright/chromium"
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      outputDir: "reports/playwright/firefox"
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      outputDir: "reports/playwright/webkit"
    }
  ]
})
