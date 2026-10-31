import { defineConfig, devices } from '@playwright/test';

// Default: starts `pnpm dev` (api + web) from the repo root, which needs the dev
// database running. Set E2E_BASE_URL (e.g. http://localhost for a Compose install
// behind Caddy) to test an app that is already running instead.
const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 740 } },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'pnpm dev',
        cwd: '../..',
        url: 'http://localhost:3001/api/health',
        reuseExistingServer: true,
        timeout: 180_000,
        // Show the dev servers' output, so a server that never comes up explains itself.
        stdout: 'pipe',
      },
});
