import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { wearHats } from './accounts';
import { E2E_ADMIN, STORAGE_STATE, ownerDatabaseUrl } from './auth';
import { signedWarehouseLicense } from './license-file';

/** The id the dynamic pages are warmed with: any id compiles the page, this one finds nothing. */
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The routes `next dev` must compile one at a time before any test runs.
 *
 * Why: on a cold `.next/dev`, `/design` loads six iframes of development only preview pages at
 * once. Their concurrent first compiles corrupt a Next manifest (`SyntaxError: Unexpected
 * non-whitespace character after JSON`, seen for `/[lang]/returns/preview/rejected` in the dev
 * server log) and from then on the dev server answers 500, failing whole suites. CI also starts
 * from a cold `next dev`, so this protects it too. Requesting each route alone first avoids the
 * race. A production server answers 404 for the development only paths, which is fine here.
 *
 * Every other page is warmed too (back office, sign in, partner, portal): a page's first compile
 * in `next dev` took 3.5 to 4.3 s when four workers opened `/orders/[orderId]` at once (2026-11-08
 * traces), and `router.push` commits the URL only after that, so a 5 s `toHaveURL` right after
 * creating an order (or signing in to a partner page) failed on a cold server. A dynamic page
 * compiles with any id; the placeholder answers a not found state. A new page joins this list.
 */
const WARM_UP_PATHS = [
  '/en/returns/preview/brand',
  '/en/returns/preview/rejected',
  '/en/partner/preview',
  '/ar/returns/preview/brand',
  '/ar/returns/preview/rejected',
  '/ar/partner/preview',
  '/design',
  '/design/phone-dashboard',
  '/',
  '/account',
  '/audit',
  '/customers',
  `/customers/${PLACEHOLDER_ID}`,
  '/locations',
  '/orders',
  `/orders/${PLACEHOLDER_ID}`,
  '/orders/new',
  '/settings',
  '/connections',
  '/connections/new',
  '/settings/cost-rules',
  '/skus',
  `/skus/${PLACEHOLDER_ID}`,
  '/staff',
  '/stock',
  '/stock-receipts',
  `/stock-receipts/${PLACEHOLDER_ID}`,
  '/stock-receipts/new',
  '/sign-in',
  '/forgot-password',
  '/reset-password',
  '/change-password',
  '/two-factor',
  '/en/partner',
  '/en/partner/account',
  '/ar/partner',
  '/ar/partner/account',
  '/en/returns',
  '/ar/returns',
];

/**
 * Requests each warm up path sequentially, signed in, and fails naming the first route that
 * answers 5xx. Redirects are followed; any non 5xx status counts as compiled.
 */
async function warmUpDevRoutes(baseURL: string, cookie: string) {
  for (const path of WARM_UP_PATHS) {
    let status: number;
    try {
      const response = await fetch(new URL(path, baseURL), {
        headers: { cookie },
        signal: AbortSignal.timeout(180_000),
      });
      status = response.status;
      await response.arrayBuffer();
    } catch (error) {
      throw new Error(`Warm up of ${path} failed: ${String(error)}`, { cause: error });
    }
    if (status >= 500) {
      throw new Error(
        `Warm up of ${path} answered ${status}. The dev server may have a corrupt .next/dev: stop it, delete apps/web/.next/dev, and rerun.`,
      );
    }
  }
}

/**
 * Records the e2e Warehouse license (`license-file.ts`) through the api, so every run starts in the
 * same license state. Why: on a database with no license (CI, or a checkout without the bootstrap
 * `LICENSE_FILE`), the manager's "no license file" banner appeared only until `license.spec.ts`
 * uploaded this same file, so it depended on test order; and it loads after the page, pushing the
 * content down while a click is on its way (the flakes of `hats.spec.ts:163` and `audit.spec.ts`
 * on 2026-11-08). The upload is append only and a no-op once recorded (`changed: false`).
 */
async function recordWarehouseLicense(baseURL: string, cookie: string) {
  const response = await fetch(new URL('/api/platform/license', baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(baseURL).origin, cookie },
    body: JSON.stringify({ envelope: await signedWarehouseLicense() }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `Recording the e2e Warehouse license failed with ${response.status}: ${await response.text()}`,
    );
  }
}

/**
 * Seeds one admin in the dev database and signs it in through the api, once, so every shell
 * test starts signed in (spec 0005). The saved cookie file is what the config hands to the
 * desktop and mobile projects. The sign in tests opt out of it.
 *
 * The api's `PUBLIC_URL` must match the address the tests open, or its Origin check refuses
 * the sign in: the default `http://localhost:3000` matches `playwright.config.ts`.
 */
// Playwright loads the default export of its global setup file.
// eslint-disable-next-line no-restricted-syntax
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('The Playwright config needs a baseURL to sign in against.');

  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    // A clean account each run. It is reset in place, never deleted: once it has posted stock,
    // the ledger's history keeps a RESTRICT reference to it (spec 0005, AC-22; spec 0006).
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (name, email, email_verified) VALUES ($1, $2, true)
       ON CONFLICT (tenant_id, (lower(email))) DO UPDATE
         SET name = EXCLUDED.name, email_verified = true, banned = false,
             ban_reason = NULL, ban_expires = NULL, two_factor_enabled = false, phone = NULL,
             staff_code = NULL, language = NULL, must_change_password = false,
             last_sign_in_at = NULL, updated_at = now()
       RETURNING id`,
      [E2E_ADMIN.name, E2E_ADMIN.email],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error('Could not seed the e2e admin');
    // The admin is a manager with the cost grant (spec 0008, AC-14).
    await wearHats(pool, userId, ['manager'], ['cost.view']);
    for (const table of ['sessions', 'accounts', 'two_factors']) {
      await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    }
    await pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [userId, await hashPassword(E2E_ADMIN.password)],
    );
  } finally {
    await pool.end();
  }

  const response = await fetch(new URL('/api/auth/sign-in/email', baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(baseURL).origin },
    body: JSON.stringify({ email: E2E_ADMIN.email, password: E2E_ADMIN.password }),
  });
  if (!response.ok) {
    throw new Error(
      `Sign in for the e2e admin failed with ${response.status}. Is the api running with PUBLIC_URL=${baseURL}?`,
    );
  }
  const cookie = response.headers.getSetCookie().find((value) => value.includes('session_token'));
  const [name, ...rest] = (cookie?.split(';')[0] ?? '').split('=');
  if (!name) throw new Error('The sign in answer carried no session cookie.');

  await recordWarehouseLicense(baseURL, `${name}=${rest.join('=')}`);
  await warmUpDevRoutes(baseURL, `${name}=${rest.join('=')}`);

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(
    STORAGE_STATE,
    JSON.stringify({
      cookies: [
        {
          name,
          value: rest.join('='),
          domain: new URL(baseURL).hostname,
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
}
