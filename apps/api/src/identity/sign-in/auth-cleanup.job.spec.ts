import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConnection } from '@ssdashboard/db';
import type { Env } from '../../config/env.js';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import { ModuleRegistry } from '../../platform/modules/module-registry.js';
import {
  AUTH_CLEANUP_EXPIRY_SECONDS,
  AUTH_CLEANUP_QUEUE,
  AUTH_CLEANUP_SCHEDULE_KEY,
  AuthCleanupJob,
} from './auth-cleanup.job.js';

const env = { AUTH_CLEANUP_CRON: '15 4 * * *' } as Env;

function makeJob(rowCounts: Array<number | null> = [1, 2, 3, 4, 5]) {
  const execute = vi.fn();
  for (const rowCount of rowCounts) execute.mockResolvedValueOnce({ rowCount });
  const jobs = new JobRegistry(new ModuleRegistry());
  const job = new AuthCleanupJob(env, { db: { execute } } as unknown as DatabaseConnection, jobs);
  return { job, execute, jobs };
}

// Spec 0005, AC-22: a nightly worker job deletes expired sign in rows; spec 0009, AC-10: its queue,
// schedule, and handler are declared through the JobRegistry with the capability identity.cleanup.
describe('AuthCleanupJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('declares one cleanup at a time on AUTH_CLEANUP_CRON for identity.cleanup (covers: AC-22)', () => {
    const { job, jobs } = makeJob();
    job.onModuleInit();

    expect(jobs.queue(AUTH_CLEANUP_QUEUE)).toEqual({
      name: AUTH_CLEANUP_QUEUE,
      capability: 'identity.cleanup',
      options: { policy: 'singleton', expireInSeconds: AUTH_CLEANUP_EXPIRY_SECONDS },
    });
    expect(jobs.schedulesOf(AUTH_CLEANUP_QUEUE)).toEqual([
      {
        queue: AUTH_CLEANUP_QUEUE,
        key: AUTH_CLEANUP_SCHEDULE_KEY,
        capability: 'identity.cleanup',
        cron: '15 4 * * *',
      },
    ]);
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
    const { job, jobs } = makeJob();
    job.onModuleInit();
    const handler = jobs.handlerFor(AUTH_CLEANUP_QUEUE, 'identity.cleanup');

    const output = await handler?.handle({ id: 'j', data: {} } as never, { before: null });

    expect(output).toEqual({
      sessions: 1,
      verifications: 2,
      signInAttempts: 3,
      signInSlots: 4,
      rateLimits: 5,
    });
  });
});
