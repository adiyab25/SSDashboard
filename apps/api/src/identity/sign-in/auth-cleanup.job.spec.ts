import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConnection } from '@ssdashboard/db';
import type { Env } from '../../config/env.js';
import { JOB_SCHEMA } from '../../inventory/ledger/reconcile.job.js';
import type { SettingsService } from '../../platform/settings.service.js';
import {
  AUTH_CLEANUP_EXPIRY_SECONDS,
  AUTH_CLEANUP_QUEUE,
  AuthCleanupJob,
} from './auth-cleanup.job.js';

// pg-boss is the boundary: a fake records what the job asks of it.
const boss = vi.hoisted(() => ({
  constructed: [] as unknown[],
  on: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  createQueue: vi.fn(),
  schedule: vi.fn(),
  work: vi.fn(),
}));

vi.mock('pg-boss', () => ({
  PgBoss: vi.fn(function (this: unknown, options: unknown) {
    boss.constructed.push(options);
    return boss;
  }),
}));

const env = {
  DATABASE_URL: 'postgres://ssdashboard_app:pw@db:5432/ssdashboard',
  AUTH_CLEANUP_CRON: '15 4 * * *',
} as Env;

function makeJob(rowCounts: Array<number | null> = [1, 2, 3, 4, 5]) {
  const execute = vi.fn();
  for (const rowCount of rowCounts) execute.mockResolvedValueOnce({ rowCount });
  const settings = { read: vi.fn().mockResolvedValue({ timezone: 'Africa/Cairo' }) };
  const job = new AuthCleanupJob(
    env,
    { db: { execute } } as unknown as DatabaseConnection,
    settings as unknown as SettingsService,
  );
  return { job, execute };
}

// Spec 0005, AC-22: a nightly worker job deletes expired sign in rows.
describe('AuthCleanupJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boss.start.mockResolvedValue(boss);
  });

  it('connects as the application role into its own schema with a small pool', async () => {
    await makeJob().job.onApplicationBootstrap();

    expect(boss.constructed.at(-1)).toEqual({
      connectionString: env.DATABASE_URL,
      schema: JOB_SCHEMA,
      createSchema: false,
      max: 2,
    });
  });

  it('runs one cleanup at a time on AUTH_CLEANUP_CRON in the install time zone (covers: AC-22)', async () => {
    await makeJob().job.onApplicationBootstrap();

    expect(boss.createQueue).toHaveBeenCalledWith(AUTH_CLEANUP_QUEUE, {
      policy: 'singleton',
      expireInSeconds: AUTH_CLEANUP_EXPIRY_SECONDS,
    });
    expect(boss.schedule).toHaveBeenCalledWith(AUTH_CLEANUP_QUEUE, '15 4 * * *', null, {
      tz: 'Africa/Cairo',
    });
  });

  it('counts what each of the five deletes removed (covers: AC-22)', async () => {
    const { job, execute } = makeJob([6, 5, 4, 3, 2]);

    await expect(job.cleanup()).resolves.toEqual({
      sessions: 6,
      verifications: 5,
      signInAttempts: 4,
      signInSlots: 3,
      rateLimits: 2,
    });
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('counts a missing row count as zero', async () => {
    const { job } = makeJob([null, null, null, null, null]);

    await expect(job.cleanup()).resolves.toEqual({
      sessions: 0,
      verifications: 0,
      signInAttempts: 0,
      signInSlots: 0,
      rateLimits: 0,
    });
  });

  it('cleans up when a job arrives and returns the counts (covers: AC-22)', async () => {
    const { job } = makeJob();
    await job.onApplicationBootstrap();
    const handler = boss.work.mock.calls[0]?.[1] as () => Promise<unknown>;

    const output = await handler();

    expect(boss.work.mock.calls[0]?.[0]).toBe(AUTH_CLEANUP_QUEUE);
    expect(output).toEqual({
      sessions: 1,
      verifications: 2,
      signInAttempts: 3,
      signInSlots: 4,
      rateLimits: 5,
    });
  });

  it('stops the queue gracefully on shutdown, and does nothing if it never started', async () => {
    await makeJob().job.onApplicationShutdown();
    expect(boss.stop).not.toHaveBeenCalled();

    const { job } = makeJob();
    await job.onApplicationBootstrap();
    await job.onApplicationShutdown();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true });
  });
});
