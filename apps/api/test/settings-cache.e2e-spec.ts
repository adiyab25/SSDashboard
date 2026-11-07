import { Test, type TestingModule } from '@nestjs/testing';
import { PutSettingAnswer } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LISTENER_RETRY,
  PLATFORM_LISTENER_NAME,
  PlatformChangesListener,
  type ListenerRetry,
} from '../src/platform/settings/platform-changes-listener.js';
import {
  SETTINGS_CACHE_LIFETIME_MS,
  SettingsCache,
} from '../src/platform/settings/settings-cache.js';
import { SettingsService } from '../src/platform/settings/settings.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

/** How long the worker's listener waits before reconnecting in this suite: past the 35 s check. */
const WORKER_RETRY: ListenerRetry = { firstMs: 40_000, maxMs: 40_000 };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Spec 0009, AC-4: a committed change reaches a running api and a running worker within 5
// seconds through LISTEN ssd_platform_changed. With the listening connections killed and the
// worker's kept down (its reconnect delay is 40 s here), the worker still reads its cached value
// until the 30 second lifetime ends and reads the change by 35 seconds: the lifetime alone, not a
// reconnect, brings it (review R1). Each listener then reconnects by itself, and a change is again
// seen within 5 seconds.
describe('settings across processes (spec 0009, AC-4)', { timeout: 180_000 }, () => {
  let api: InProcessApi;
  let worker: TestingModule;
  let cookie: string;
  let updatedAt: string | null = null;
  const KEY = 'operations_wind_down_days';

  const apiSide = () => ({
    settings: api.app.get(SettingsService),
    listener: api.app.get(PlatformChangesListener),
  });
  const workerSide = () => ({
    settings: worker.get(SettingsService),
    listener: worker.get(PlatformChangesListener),
    cache: worker.get(SettingsCache),
  });

  /** Polls until both processes read `value` without a transaction; returns how long it took. */
  const seenBy = async (value: number, withinMs: number): Promise<number> => {
    const started = Date.now();
    for (;;) {
      const read = await Promise.all(
        [apiSide(), workerSide()].map(({ settings }) => settings.get(KEY)),
      );
      if (read.every((found) => found === value)) return Date.now() - started;
      if (Date.now() - started > withinMs) {
        throw new Error(`still reading ${JSON.stringify(read)} after ${withinMs} ms`);
      }
      await pause(100);
    }
  };

  const change = async (value: number): Promise<void> => {
    const reply = await api.call(cookie, 'PUT', `/api/settings/${KEY}`, {
      value,
      reason: `Set to ${value} by the cache test`,
      expectedUpdatedAt: updatedAt,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    updatedAt = PutSettingAnswer.parse(reply.body).entry.updatedAt;
  };

  const listeners = async (): Promise<number> => {
    const { rows } = await api.owner.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $1`,
      [PLATFORM_LISTENER_NAME],
    );
    return rows[0]?.n ?? 0;
  };

  /** Polls until `done` holds, failing after `withinMs`. */
  const until = async (done: () => Promise<boolean>, withinMs: number, what: string) => {
    const started = Date.now();
    while (!(await done())) {
      if (Date.now() - started > withinMs) throw new Error(`${what} after ${withinMs} ms`);
      await pause(200);
    }
  };

  beforeAll(async () => {
    api = await startInProcessApi();
    // The worker entry point's own module graph on the same database (env set by the api), with
    // a slow reconnect so the lifetime case can keep its listener down.
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(LISTENER_RETRY)
      .useValue(WORKER_RETRY)
      .compile();
    worker.useLogger(false);
    await worker.init();
    const manager = await api.addPerson(['manager']);
    cookie = await api.signIn(manager.email);
  });

  afterAll(async () => {
    await worker?.close();
    await api?.close();
  });

  it('shows a committed change in the api and the worker within 5 seconds', async () => {
    expect(apiSide().listener.listening && workerSide().listener.listening).toBe(true);
    // Both caches hold the default before the change.
    expect(await seenBy(60, 1_000)).toBeLessThan(1_000);

    await change(90);

    expect(await seenBy(90, 5_000)).toBeLessThan(5_000);
  });

  it('with the worker not listening, shows a change by the 30 second lifetime, then listens again', async () => {
    const side = workerSide();
    // A fresh cache entry for the worker: it lives 30 seconds from here.
    side.cache.drop(KEY);
    expect(await side.settings.get(KEY)).toBe(90);
    const loadedAt = Date.now();

    const { rowCount } = await api.owner.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $1`,
      [PLATFORM_LISTENER_NAME],
    );
    expect(rowCount).toBe(2);
    await until(() => Promise.resolve(!side.listener.listening), 5_000, 'the worker still listens');

    await change(120);
    const changedAt = Date.now();

    // The api dropped its own entry; the worker heard nothing and keeps 90 until the lifetime ends.
    expect(await apiSide().settings.get(KEY)).toBe(120);
    let seenAt: number | undefined;
    while (seenAt === undefined) {
      const read = await side.settings.get(KEY);
      if (read === 120) seenAt = Date.now();
      else if (Date.now() - changedAt > 35_000)
        throw new Error('the worker still reads 90 at 35 s');
      else await pause(250);
    }
    expect(side.listener.listening).toBe(false);
    expect(seenAt - loadedAt).toBeGreaterThanOrEqual(SETTINGS_CACHE_LIFETIME_MS - 1_000);
    expect(seenAt - changedAt).toBeLessThan(35_000);

    // Each listener reconnects by itself: the api within its 0.5 s backoff, the worker at 40 s.
    await until(
      () => Promise.resolve(apiSide().listener.listening),
      10_000,
      'the api did not listen again',
    );
    await until(
      async () => side.listener.listening && (await listeners()) === 2,
      60_000,
      'the worker did not listen again',
    );
    await change(150);
    expect(await seenBy(150, 5_000)).toBeLessThan(5_000);
  });
});
