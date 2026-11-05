import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { E2E_ADMIN, STORAGE_STATE, ownerDatabaseUrl } from './auth';

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
      `INSERT INTO users (name, email, role, email_verified) VALUES ($1, $2, 'admin', true)
       ON CONFLICT ((lower(email))) DO UPDATE
         SET name = EXCLUDED.name, role = 'admin', email_verified = true, banned = false,
             ban_reason = NULL, ban_expires = NULL, two_factor_enabled = false, phone = NULL,
             staff_code = NULL, language = NULL, must_change_password = false,
             last_sign_in_at = NULL, updated_at = now()
       RETURNING id`,
      [E2E_ADMIN.name, E2E_ADMIN.email],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error('Could not seed the e2e admin');
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
