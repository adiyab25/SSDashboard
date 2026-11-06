import { Logger } from '@nestjs/common';
import { SessionTenantMismatch, type DatabaseConnection } from '@ssdashboard/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseModule, stopOnTenantMismatch } from './database.module.js';

/** A connection whose pool answers the tenant check with the given row, or fails with the error. */
function connectionAnswering(answer: { session: string | null; installed: string } | Error) {
  const query = vi.fn(() =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ rows: [answer] }),
  );
  return { db: {}, pool: { query } } as unknown as DatabaseConnection;
}

const INSTALLED = '01a1b120-0000-7000-8000-000000000001';

// Security review S3 (a): the api and the worker both import DatabaseModule, so its start hook is
// where both refuse a session tenant that is not the install row.
describe('DatabaseModule start check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts when the session tenant is the install row', async () => {
    const module = new DatabaseModule(
      connectionAnswering({ session: INSTALLED, installed: INSTALLED }),
    );

    await expect(module.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it.each([
    ['another tenant', '01a1b120-0000-7000-8000-00000000beef'],
    ['no tenant setting', null],
  ])('refuses to start with %s (SessionTenantMismatch)', async (_case, session) => {
    const module = new DatabaseModule(connectionAnswering({ session, installed: INSTALLED }));

    await expect(module.onApplicationBootstrap()).rejects.toBeInstanceOf(SessionTenantMismatch);
  });

  it('still starts, degraded, when the database cannot be reached, and says so', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const module = new DatabaseModule(connectionAnswering(new Error('connect ECONNREFUSED')));

    await expect(module.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  // Security review S10: the pool runs the same check on every connection it opens later (a
  // database unreachable at start included) and calls this handler on a mismatch.
  it('stops the process with exit code 1 on a mismatch found after start, and says why', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() =>
      stopOnTenantMismatch(
        new SessionTenantMismatch(INSTALLED, '01a1b120-0000-7000-8000-00000000beef'),
      ),
    ).toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SessionTenantMismatch'));
  });
});
