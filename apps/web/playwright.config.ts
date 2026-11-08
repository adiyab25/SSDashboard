import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/auth';

// Default: starts the api from its build (`node dist/main.js`, never the `nest start --watch`
// dev server) and `next dev`, both against the dev database. Set E2E_BASE_URL (e.g.
// http://localhost for a Compose install behind Caddy) to test an app that is already running
// instead.
const externalBaseUrl = process.env.E2E_BASE_URL;
// Every port the config starts a server on can be moved, for a checkout where the defaults are
// taken; CI sets none of them.
const webPort = process.env.E2E_WEB_PORT ?? '3000';
const apiPort = process.env.E2E_API_PORT ?? '3001';
const baseURL = externalBaseUrl ?? `http://localhost:${webPort}`;
const apiURL = `http://localhost:${apiPort}`;

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
            // The api from its build, not the watcher: `nest start --watch` restarted the api up
            // to 17 times in one run with no file changed (2026-11-08), failing every test in
            // flight. The turbo build is a cache hit after `pnpm test:e2e` built everything, and
            // rebuilds a stale `dist` when the suite runs alone. Its Origin check must match the
            // address the tests open.
            command:
              'pnpm exec turbo run build --filter=@ssdashboard/api --output-logs=errors-only && pnpm --filter @ssdashboard/api start',
            cwd: '../..',
            url: `${apiURL}/api/health`,
            // Mail off, as in CI (no `.env` there): the suite checks the mail off flows
            // (auth-flows.spec.ts), and a local `.env` from `.env.example` turns SMTP on.
            env: {
              PORT: apiPort,
              API_INTERNAL_URL: apiURL,
              PUBLIC_URL: baseURL,
              MAIL_DRIVER: 'none',
            },
            // CI never reuses one: an api already on the port could be a `pnpm dev` watcher.
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
            // Show the server's output, so a server that never comes up (or restarts) explains itself.
            stdout: 'pipe' as const,
          },
          {
            command: `pnpm exec next dev --port ${webPort}`,
            url: baseURL,
            env: { API_INTERNAL_URL: apiURL, PUBLIC_URL: baseURL },
            reuseExistingServer: true,
            timeout: 180_000,
            stdout: 'pipe' as const,
          },
        ]),
    ...(externalProdUrl
      ? []
      : [
          {
            command: `pnpm exec next start --port ${prodPort}`,
            url: prodBaseURL,
            // The session check must reach this run's api.
            env: { API_INTERNAL_URL: apiURL },
            reuseExistingServer: true,
            timeout: 120_000,
          },
        ]),
  ],
});
