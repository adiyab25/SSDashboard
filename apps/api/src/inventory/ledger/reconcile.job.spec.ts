import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import type { SettingsService } from '../../platform/settings.service.js';
import { JOB_SCHEMA, RECONCILE_QUEUE, ReconcileJob } from './reconcile.job.js';
import type { ReconciliationService } from './reconciliation.service.js';

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
  LEDGER_RECONCILE_CRON: '30 3 * * *',
} as Env;

function makeJob(found = 0) {
  const reconcile = vi.fn().mockResolvedValue(found);
  const settings = { read: vi.fn().mockResolvedValue({ timezone: 'Africa/Cairo' }) };
  const job = new ReconcileJob(
    env,
    settings as unknown as SettingsService,
    { reconcile } as unknown as ReconciliationService,
  );
  return { job, reconcile, settings };
}

// Spec 0002, AC-11: the nightly reconciliation runs in the worker on LEDGER_RECONCILE_CRON.
describe('ReconcileJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boss.start.mockResolvedValue(boss);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('connects as the application role into its own schema, without creating it', async () => {
    await makeJob().job.onApplicationBootstrap();

    expect(boss.constructed.at(-1)).toEqual({
      connectionString: env.DATABASE_URL,
      schema: JOB_SCHEMA,
      createSchema: false,
    });
    expect(boss.start).toHaveBeenCalledOnce();
  });

  it('runs one reconciliation at a time (covers: AC-11)', async () => {
    await makeJob().job.onApplicationBootstrap();

    expect(boss.createQueue).toHaveBeenCalledWith(RECONCILE_QUEUE, { policy: 'singleton' });
  });

  it('schedules the job on LEDGER_RECONCILE_CRON in the install time zone (covers: AC-11)', async () => {
    await makeJob().job.onApplicationBootstrap();

    expect(boss.schedule).toHaveBeenCalledWith(RECONCILE_QUEUE, '30 3 * * *', null, {
      tz: 'Africa/Cairo',
    });
  });

  it('reconciles when a job arrives and returns how many it found (covers: AC-11)', async () => {
    const { job, reconcile } = makeJob(3);
    await job.onApplicationBootstrap();
    const handler = boss.work.mock.calls[0]?.[1] as () => Promise<unknown>;

    const output = await handler();

    expect(boss.work.mock.calls[0]?.[0]).toBe(RECONCILE_QUEUE);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(output).toEqual({ found: 3 });
  });

  it('logs queue errors instead of crashing the worker', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeJob().job.onApplicationBootstrap();
    const [event, listener] = boss.on.mock.calls[0] as [string, (error: Error) => void];

    listener(new Error('connection lost'));

    expect(event).toBe('error');
    expect(log).toHaveBeenCalledWith('Job queue error: connection lost');
  });

  it('stops the queue gracefully on shutdown, and does nothing if it never started', async () => {
    const idle = makeJob().job;
    await idle.onApplicationShutdown();
    expect(boss.stop).not.toHaveBeenCalled();

    const { job } = makeJob();
    await job.onApplicationBootstrap();
    await job.onApplicationShutdown();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true });
  });
});
