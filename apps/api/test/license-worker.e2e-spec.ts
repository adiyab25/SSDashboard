import { Test, type TestingModule } from '@nestjs/testing';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_SCHEMA } from '../src/platform/job-schema.js';
import { LICENSE_CHECK_QUEUE } from '../src/platform/license/license-check.job.js';
import { WorkerModule } from '../src/worker.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Spec 0009 milestone 2 (AC-14), review M2 code 6: the worker entry point's own module graph
// checks the license at start (a `worker_start` row), schedules the daily check at
// LICENSE_CHECK_CRON in the install's `timezone` setting, and its handler records a `daily` row.
describe('the worker license check (spec 0009 milestone 2)', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let worker: TestingModule;
  let sender: PgBoss | undefined;

  beforeAll(async () => {
    process.env.LICENSE_CHECK_CRON = '5 1 * * *';
    // The api makes the scratch database and the env the worker reads.
    api = await startInProcessApi();
    // A zone other than the default, so the schedule proves it reads the setting.
    await api.owner.pool.query(
      `UPDATE settings SET value = '"Asia/Dubai"'::jsonb WHERE key = 'timezone'`,
    );
    worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    worker.useLogger(false);
    await worker.init();
  });

  afterAll(async () => {
    await sender?.stop({ graceful: false });
    await worker?.close();
    await api?.close();
    delete process.env.LICENSE_CHECK_CRON;
  });

  it('checks at worker start and schedules the daily check in the timezone setting', async () => {
    const checks = await api.owner.pool.query<{ trigger: string; outcome: string }>(
      `SELECT trigger, outcome FROM license_checks ORDER BY seq`,
    );
    expect(checks.rows).toEqual([
      { trigger: 'api_start', outcome: 'none_configured' },
      { trigger: 'worker_start', outcome: 'none_configured' },
    ]);
    const schedules = await api.owner.pool.query(
      `SELECT cron, timezone FROM pgboss.schedule WHERE name = $1`,
      [LICENSE_CHECK_QUEUE],
    );
    expect(schedules.rows).toEqual([{ cron: '5 1 * * *', timezone: 'Asia/Dubai' }]);
  });

  it('records a daily check when the job runs', async () => {
    sender = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      schema: JOB_SCHEMA,
      createSchema: false,
      max: 1,
      supervise: false,
      schedule: false,
    });
    sender.on('error', () => undefined);
    await sender.start();
    await sender.send(LICENSE_CHECK_QUEUE, {});

    // The worker polls every 2 seconds; wait for the job to complete.
    let job: { state: string; output: unknown } | undefined;
    for (let tries = 0; tries < 150 && job?.state !== 'completed'; tries += 1) {
      await pause(200);
      const { rows } = await api.owner.pool.query<{ state: string; output: unknown }>(
        `SELECT state::text AS state, output FROM pgboss.job WHERE name = $1`,
        [LICENSE_CHECK_QUEUE],
      );
      job = rows[0];
    }
    expect(job).toEqual({
      state: 'completed',
      output: { outcome: 'none_configured', operations: 'not_licensed', warehouse: 'not_licensed' },
    });
    const { rows } = await api.owner.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM license_checks WHERE trigger = 'daily'`,
    );
    expect(rows[0]?.n).toBe(1);
  });
});
