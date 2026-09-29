import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // Retry on CI to absorb transient flakes (Soroban node startup, network
  // timing). Locally, fail fast so developers notice real bugs.
  retries: process.env.CI ? 2 : 0,
  // Cap individual test duration. 30s is enough once the local node is warm.
  timeout: 30_000,
  // Default timeout for expect() assertions — replaces per-assertion
  // { timeout: 8000 } / { timeout: 10_000 } sprinkled through the spec.
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
