import { createHmac, randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { ownerDatabaseUrl } from './auth';

export const SEEDED_PASSWORD = 'Seeded-Pass-1';

export interface SeededAccount {
  id: string;
  name: string;
  email: string;
  password: string;
  remove(): Promise<void>;
}

/**
 * Inserts one throwaway account straight into the dev database (the way `global-setup.ts`
 * seeds the admin), so a test can change its password, enrol two factor or disable it without
 * touching the shared admin. `mustChangePassword` makes it a person on a temporary password.
 */
export async function seedAccount(
  options: {
    role?: 'admin' | 'staff';
    mustChangePassword?: boolean;
    name?: string;
    language?: string;
  } = {},
): Promise<SeededAccount> {
  const tag = randomUUID().slice(0, 8);
  const name = options.name ?? `E2E Person ${tag}`;
  const email = `e2e-${tag}@example.com`;
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  let id: string | undefined;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (name, email, role, email_verified, must_change_password, language)
       VALUES ($1, $2, $3, true, $4, $5) RETURNING id`,
      [
        name,
        email,
        options.role ?? 'staff',
        options.mustChangePassword ?? false,
        options.language ?? null,
      ],
    );
    id = rows[0]?.id;
    if (!id) throw new Error('Could not seed the e2e account');
    await pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [id, await hashPassword(SEEDED_PASSWORD)],
    );
  } catch (error) {
    // Do not leave a half seeded person or an open pool behind; the original error wins.
    try {
      await pool.query(`DELETE FROM users WHERE lower(email) = $1`, [email]);
    } catch {
      // ignore: the seed error below is the useful one
    }
    await pool.end().catch(() => undefined);
    throw error;
  }
  const userId = id;
  return {
    id: userId,
    name,
    email,
    password: SEEDED_PASSWORD,
    async remove() {
      try {
        // Sessions, accounts and two factor rows go with the user (on delete cascade).
        await pool.query(`DELETE FROM users WHERE id = $1::uuid OR lower(email) = $2`, [
          userId,
          email,
        ]);
      } finally {
        await pool.end();
      }
    },
  };
}

/** Removes any account the staff page created through the UI, by its email. */
export async function removeAccountByEmail(email: string): Promise<void> {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    await pool.query(`DELETE FROM users WHERE lower(email) = $1`, [email.toLowerCase()]);
  } finally {
    await pool.end();
  }
}

/**
 * A made up client address for the api's per address sign in limit (spec 0005, AC-4). The suite
 * signs many people in from one machine, and a real install's Caddy would set this header; the
 * api reads the first entry. Pass it as `extraHTTPHeaders` of a context, or as request headers.
 */
export function ownAddress(): Record<string, string> {
  const byte = () => Math.floor(Math.random() * 250) + 1;
  return { 'x-forwarded-for': `10.${byte()}.${byte()}.${byte()}` };
}

/** Signs a seeded account in through the api, so the context holds its session cookie. */
export async function signInThroughApi(
  context: BrowserContext,
  account: Pick<SeededAccount, 'email' | 'password'>,
  baseURL: string,
): Promise<void> {
  const response = await context.request.post(new URL('/api/auth/sign-in/email', baseURL).href, {
    headers: { origin: new URL(baseURL).origin, ...ownAddress() },
    data: { email: account.email, password: account.password },
  });
  if (!response.ok()) throw new Error(`Sign in for ${account.email} failed: ${response.status()}`);
}

/** Types the email and password on the sign in page and submits (the way a person does). */
export async function signInThroughPage(
  page: Page,
  account: Pick<SeededAccount, 'email' | 'password'>,
  path = '/sign-in',
): Promise<void> {
  const hydrated = page.waitForResponse((response) => response.url().endsWith('/api/config'));
  await page.goto(path);
  await hydrated;
  await page.getByLabel(/^Email/).fill(account.email);
  await page.getByLabel(/^Password/).fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The 6 digit TOTP (RFC 6238, SHA-1, 30 s step) for a base32 setup key, as an authenticator shows it. */
export function totp(secretBase32: string, at = Date.now()): string {
  const clean = secretBase32.replace(/[\s=]/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0xf;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}
