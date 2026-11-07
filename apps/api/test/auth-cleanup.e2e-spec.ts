import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConnection } from '@ssdashboard/db';
import { AuthCleanupJob } from '../src/identity/sign-in/auth-cleanup.job.js';
import type { Env } from '../src/config/env.js';
import { SettingsService } from '../src/platform/settings/settings.service.js';
import { ledgerHarness, type LedgerHarness } from './ledger.js';

// Spec 0005, AC-22: the nightly cleanup removes expired rows and leaves live ones, on PostgreSQL.
describe('auth cleanup', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let owner: DatabaseConnection;
  let job: AuthCleanupJob;

  const run = (text: string, values: unknown[] = []) => owner.pool.query(text, values);
  const left = async (table: string, column: string) =>
    (await run(`SELECT ${column} AS k FROM ${table} ORDER BY ${column}`)).rows.map(
      (row: { k: string }) => row.k,
    );

  beforeAll(async () => {
    h = await ledgerHarness();
    owner = h.owner;
    // Acts as the application role, so a missing DELETE grant would fail here.
    job = new AuthCleanupJob({} as Env, h.app, new SettingsService(h.app));

    const user = (
      await run(
        `INSERT INTO users (name, email) VALUES ('Cleanup', 'cleanup@example.test') RETURNING id`,
      )
    ).rows[0] as { id: string };
    const past = "now() - interval '1 minute'";
    const future = "now() + interval '1 hour'";
    for (const [token, when] of [
      ['expired', past],
      ['live', future],
    ] as const) {
      await run(`INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, ${when})`, [
        user.id,
        token,
      ]);
    }
    for (const [identifier, when] of [
      ['expired', past],
      ['live', future],
    ] as const) {
      await run(
        `INSERT INTO verifications (identifier, value, expires_at) VALUES ($1, 'v', ${when})`,
        [identifier],
      );
    }
    // Window 10 minutes, lock 15 minutes: only "idle" and "lock-ended" are fully over.
    for (const [key, window, lock] of [
      ['idle', "now() - interval '11 minutes'", 'NULL'],
      ['lock-ended', "now() - interval '30 minutes'", past],
      ['window-running', "now() - interval '2 minutes'", 'NULL'],
      ['lock-running', "now() - interval '30 minutes'", "now() + interval '5 minutes'"],
    ] as const) {
      await run(
        `INSERT INTO sign_in_attempts (email_key, scope, failures, window_started_at, locked_until)
         VALUES ($1, '*', 3, ${window}, ${lock})`,
        [key],
      );
    }
    // A slot holds a place for 60 seconds: only "stale" is left over from a request that died.
    for (const [key, age] of [
      ['stale', "now() - interval '61 seconds'"],
      ['held', "now() - interval '5 seconds'"],
    ] as const) {
      await run(`INSERT INTO sign_in_slots (email_key, ip, created_at) VALUES ($1, '*', ${age})`, [
        key,
      ]);
    }
    const dayMs = 24 * 60 * 60 * 1000;
    for (const [key, age] of [
      ['old', dayMs + 60_000],
      ['recent', 60_000],
    ] as const) {
      await run(`INSERT INTO rate_limits (key, count, last_request) VALUES ($1, 1, $2)`, [
        key,
        Date.now() - age,
      ]);
    }
  });

  afterAll(async () => {
    await h?.close();
  });

  it('deletes expired rows in all five tables and keeps live ones (covers: AC-22)', async () => {
    const counts = await job.cleanup();

    expect(counts).toEqual({
      sessions: 1,
      verifications: 1,
      signInAttempts: 2,
      signInSlots: 1,
      rateLimits: 1,
    });
    expect(await left('sessions', 'token')).toEqual(['live']);
    expect(await left('verifications', 'identifier')).toEqual(['live']);
    expect(await left('sign_in_attempts', 'email_key')).toEqual(['lock-running', 'window-running']);
    expect(await left('sign_in_slots', 'email_key')).toEqual(['held']);
    expect(await left('rate_limits', 'key')).toEqual(['recent']);
  });

  it('removes nothing on a second run', async () => {
    await expect(job.cleanup()).resolves.toEqual({
      sessions: 0,
      verifications: 0,
      signInAttempts: 0,
      signInSlots: 0,
      rateLimits: 0,
    });
  });
});
