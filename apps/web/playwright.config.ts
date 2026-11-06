import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/auth';

// Default: starts `pnpm dev` (api + web) from the repo root, which needs the dev
// database running. Set E2E_BASE_URL (e.g. http://localhost for a Compose install
// behind Caddy) to test an app that is already running instead.
const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://localhost:3000';

// The production project checks what only a production build does (no /design, no
// direction switch, real 404 statuses) and also runs the portal language spec. It runs
// `next start` on the build `pnpm test:e2e` makes first, or an already running production
// server at E2E_PROD_BASE_URL.
const externalProdUrl = process.env.E2E_PROD_BASE_URL;
const prodPort = process.env.E2E_PROD_PORT ?? '3100';
const prodBaseURL = externalProdUrl ?? `http://localhost:${prodPort}`;

export default defineConfig({
  testDir: './e2e',
  // Seeds an admin and signs it in once; the shell projects reuse that cookie (spec 0005).
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    {
      name: 'desktop',
      testIgnore: /production\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        storageState: STORAGE_STATE,
      },
    },
    {
      name: 'mobile',
      testIgnore: /production\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 740 },
        isMobile: true,
        hasTouch: true,
        storageState: STORAGE_STATE,
      },
    },
    {
      name: 'production',
      testMatch: /(production|portal-language)\.spec\.ts/,
      // Signed in as the seeded admin: since spec 0005 every shell page asks for a session first,
      // so a signed out visit would only ever reach the sign in page. That check calls the api, so
      // this server needs API_INTERNAL_URL pointing at a running api. The saved cookie belongs to
      // the dev hostname (localhost), so the production server must use the same hostname.
      use: {
        ...devices['Desktop Chrome'],
        baseURL: prodBaseURL,
        storageState: STORAGE_STATE,
      },
    },
  ],
  webServer: [
    ...(externalBaseUrl
      ? []
      : [
          {
            command: 'pnpm dev',
            cwd: '../..',
            url: 'http://localhost:3001/api/health',
            reuseExistingServer: true,
            timeout: 180_000,
            // Show the dev servers' output, so a server that never comes up explains itself.
            stdout: 'pipe' as const,
          },
        ]),
    ...(externalProdUrl
      ? []
      : [
          {
            command: `pnpm exec next start --port ${prodPort}`,
            url: prodBaseURL,
            reuseExistingServer: true,
            timeout: 120_000,
          },
        ]),
  ],
});
