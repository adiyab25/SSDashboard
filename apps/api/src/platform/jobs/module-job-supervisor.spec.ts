import { Logger } from '@nestjs/common';
import {
  defineModule,
  MODULE_REGISTRY,
  type EffectiveState,
  type ModuleStates,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import type { LicenseService, RenewalGap } from '../license/license.service.js';
import type { Job, PgBoss } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityHooks } from '../modules/capability-hooks.js';
import { ModuleRegistry } from '../modules/module-registry.js';
import type { ModuleStateService } from '../modules/module-state.service.js';
import type { PlatformChangesListener } from '../settings/platform-changes-listener.js';
import type { SettingsService } from '../settings/settings.service.js';
import { defineQueue } from './job-declarations.js';
import type { JobBoss } from './job-boss.js';
import { JobRegistry } from './job-registry.js';
import { JobHandlerFailed, ModuleJobSupervisor } from './module-job-supervisor.js';

const FIXTURES = [
  defineModule({
    key: 'ops',
    bundle: 'operations',
    toggle: true,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'ops.queue',
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
  defineModule({
    key: 'shared',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'shared.sync',
        bundle: 'core',
        kind: 'read',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'shared.push',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
];
// A core module holding a Warehouse capability that waits for an Operations source (AC-29).
FIXTURES.push(
  defineModule({
    key: 'stock',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'stock.push',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'none',
        requiresOneOf: [],
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
);
const OPS_QUEUE = defineQueue({ name: 'ops.work', capability: 'ops.queue', options: {} });
const SHARED_QUEUE = defineQueue({ name: 'shared.work', capability: 'shared.sync', options: {} });

const ON: EffectiveState = { state: 'on', since: null };
const STOPPED: EffectiveState = { state: 'read_only', reason: 'toggled_off', since: null };

/** A fake pg-boss that records calls and keeps schedules and queued job ids in memory. */
function fakeBoss() {
  const schedules: { name: string; key: string; cron: string; timezone: string; data: object }[] =
    [];
  const queued = new Map<string, { id: string; data: Record<string, unknown> }[]>();
  const boss = {
    getSchedules: vi.fn((name: string) =>
      Promise.resolve(schedules.filter((s) => s.name === name).map((s) => ({ ...s }))),
    ),
    schedule: vi.fn(
      (name: string, cron: string, data: object, options: { tz: string; key: string }) => {
        const at = schedules.findIndex((s) => s.name === name && s.key === options.key);
        if (at >= 0) schedules.splice(at, 1);
        schedules.push({ name, key: options.key, cron, timezone: options.tz, data });
        return Promise.resolve();
      },
    ),
    unschedule: vi.fn((name: string, key: string) => {
      const at = schedules.findIndex((s) => s.name === name && s.key === key);
      if (at >= 0) schedules.splice(at, 1);
      return Promise.resolve();
    }),
    work: vi.fn((..._args: unknown[]) => Promise.resolve('w')),
    offWork: vi.fn((..._args: unknown[]) => Promise.resolve()),
    findJobs: vi.fn((name: string, options: { data?: Record<string, unknown> }) =>
      Promise.resolve(
        (queued.get(name) ?? []).filter((job) =>
          Object.entries(options.data ?? {}).every(([k, v]) => job.data[k] === v),
        ),
      ),
    ),
    cancel: vi.fn((name: string, ids: string[]) => {
      queued.set(
        name,
        (queued.get(name) ?? []).filter((job) => !ids.includes(job.id)),
      );
      return Promise.resolve({});
    }),
    send: vi.fn((..._args: unknown[]) => Promise.resolve('sent')),
    updateQueue: vi.fn((..._args: unknown[]) => Promise.resolve()),
  };
  return { boss, schedules, queued };
}

function setup() {
  const registry = new ModuleRegistry([...MODULE_REGISTRY, ...FIXTURES]);
  const states = new Map<string, EffectiveState>([
    ['ops.queue', ON],
    ['shared.push', ON],
  ]);
  const snapshot = (): ModuleStates => ({
    modules: new Map(),
    capabilities: new Map(states),
    steps: new Map(),
  });
  const stateService = {
    states: vi.fn(() => Promise.resolve(snapshot())),
    stateOf: vi.fn((key: string) => Promise.resolve(states.get(key) ?? ON)),
    isRunnable: vi.fn(() => Promise.resolve(true)),
  } as unknown as ModuleStateService;
  const { boss, schedules, queued } = fakeBoss();
  const jobBoss = {
    start: () => Promise.resolve(boss as unknown as PgBoss),
    ensureQueue: () => Promise.resolve(boss as unknown as PgBoss),
  } as unknown as JobBoss;
  const jobs = new JobRegistry(registry);
  const hooks = new CapabilityHooks(registry);
  const onDisable = vi.fn(() => Promise.resolve());
  const backfill = vi.fn(() => Promise.resolve());
  hooks.register('ops.queue', { onDisable, backfill });
  const openTask = vi.fn(() => Promise.resolve());
  hooks.registerTasks({ open: openTask });
  const renewals: RenewalGap[] = [];
  const license = {
    renewalGaps: vi.fn(() => Promise.resolve([...renewals])),
  } as unknown as LicenseService;
  const failWaitingCommands = vi.fn(() => Promise.resolve(1));
  hooks.registerCommands({ failWaitingCommands, waitingCommands: () => Promise.resolve([]) });
  const timezone = { value: 'Africa/Cairo' };
  const settings = {
    read: () => Promise.resolve({ timezone: timezone.value }),
  } as unknown as SettingsService;
  const listener = {
    subscribe: vi.fn(() => () => undefined),
  } as unknown as PlatformChangesListener;
  const supervisor = new ModuleJobSupervisor(
    jobBoss,
    jobs,
    registry,
    stateService,
    settings,
    hooks,
    listener,
    { db: {} } as unknown as DatabaseConnection,
    license,
  );
  supervisor.onModuleInit();
  const opsHandle = vi.fn(() => Promise.resolve({ done: true }));
  jobs.declareQueue(OPS_QUEUE);
  jobs.declareHandler({ queue: OPS_QUEUE.name, capability: 'ops.queue', handle: opsHandle });
  jobs.declareSchedule({
    queue: OPS_QUEUE.name,
    key: 'nightly',
    capability: 'ops.queue',
    cron: '0 3 * * *',
  });
  jobs.declareQueue(SHARED_QUEUE);
  jobs.declareHandler({ queue: SHARED_QUEUE.name, capability: 'shared.sync', handle: opsHandle });
  jobs.declareHandler({ queue: SHARED_QUEUE.name, capability: 'shared.push', handle: opsHandle });
  jobs.declareSchedule({
    queue: SHARED_QUEUE.name,
    key: 'sweep',
    capability: 'shared.sync',
    cron: '*/5 * * * *',
  });
  jobs.declareSchedule({
    queue: SHARED_QUEUE.name,
    key: 'push',
    capability: 'shared.push',
    cron: '* * * * *',
  });
  return {
    supervisor,
    boss,
    schedules,
    queued,
    states,
    onDisable,
    failWaitingCommands,
    opsHandle,
    timezone,
    openTask,
    renewals,
  };
}

// Spec 0009, AC-10, AC-11, AC-22: the module job supervisor.
describe('ModuleJobSupervisor', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  it('registers every runnable schedule in the timezone setting and works every queue', async () => {
    const { supervisor, boss, schedules } = setup();
    await supervisor.reconcile();

    expect(schedules.map((s) => `${s.name}/${s.key}@${s.timezone}`).sort()).toEqual([
      'ops.work/nightly@Africa/Cairo',
      'shared.work/push@Africa/Cairo',
      'shared.work/sweep@Africa/Cairo',
    ]);
    expect(schedules.find((s) => s.key === 'push')?.data).toEqual({ capability: 'shared.push' });
    expect(boss.work.mock.calls.map((call) => call[0] as string).sort()).toEqual([
      'ops.work',
      'platform.backfill',
      'platform.reconcile_modules',
      'shared.work',
    ]);
  });

  it('re registers schedules in a new time zone and leaves equal ones alone (R11)', async () => {
    const { supervisor, boss, schedules, timezone } = setup();
    await supervisor.reconcile();
    boss.schedule.mockClear();
    await supervisor.reconcile();
    expect(boss.schedule).not.toHaveBeenCalled();

    timezone.value = 'Asia/Dubai';
    await supervisor.reconcile();
    expect(schedules.every((s) => s.timezone === 'Asia/Dubai')).toBe(true);
  });

  it('stops an owner: unschedules, stops work, cancels its queued jobs, fails commands, calls onDisable', async () => {
    const { supervisor, boss, schedules, queued, states, onDisable, failWaitingCommands } = setup();
    await supervisor.reconcile();
    queued.set('ops.work', [{ id: 'a', data: { capability: 'ops.queue' } }]);
    states.set('ops.queue', STOPPED);

    const report = await supervisor.reconcile();

    expect(schedules.some((s) => s.name === 'ops.work')).toBe(false);
    expect(boss.offWork).toHaveBeenCalledWith('ops.work', { wait: false });
    expect(queued.get('ops.work')).toEqual([]);
    expect(failWaitingCommands).toHaveBeenCalledWith('ops.queue', 'MODULE_OFF', undefined);
    expect(onDisable).toHaveBeenCalledWith({ state: 'read_only', reason: 'toggled_off' });
    expect(report.stopped).toEqual(['ops.queue']);

    // A second reconcile while it stays stopped does nothing more.
    await supervisor.reconcile();
    expect(onDisable).toHaveBeenCalledOnce();
  });

  it('stops only a capability on a shared queue while its owner runs', async () => {
    const { supervisor, boss, schedules, queued, states } = setup();
    await supervisor.reconcile();
    queued.set('shared.work', [
      { id: 'sync', data: { capability: 'shared.sync' } },
      { id: 'push', data: { capability: 'shared.push' } },
    ]);
    states.set('shared.push', { state: 'off', reason: 'not_licensed', since: null });

    await supervisor.reconcile();

    expect(schedules.filter((s) => s.name === 'shared.work').map((s) => s.key)).toEqual(['sweep']);
    expect(queued.get('shared.work')?.map((job) => job.id)).toEqual(['sync']);
    expect(boss.offWork).not.toHaveBeenCalledWith('shared.work', expect.anything());
  });

  it('restores schedules and work when the capability runs again', async () => {
    const { supervisor, boss, schedules, states } = setup();
    states.set('ops.queue', STOPPED);
    await supervisor.reconcile();
    expect(schedules.some((s) => s.name === 'ops.work')).toBe(false);

    states.set('ops.queue', ON);
    await supervisor.reconcile();
    expect(schedules.some((s) => s.name === 'ops.work' && s.key === 'nightly')).toBe(true);
    expect(boss.work.mock.calls.filter((call) => call[0] === 'ops.work')).toHaveLength(1);
  });

  it('completes a job of a stopped capability skipped, never calling its handler', async () => {
    const { supervisor, boss, states, opsHandle } = setup();
    await supervisor.reconcile();
    const call = boss.work.mock.calls.find((c) => c[0] === 'shared.work') as unknown[];
    const dispatch = call[2] as (jobs: Job<object>[]) => Promise<unknown>;
    states.set('shared.push', STOPPED);

    const skipped = await dispatch([
      { id: '1', data: { capability: 'shared.push' } } as Job<object>,
    ]);
    const worked = await dispatch([
      { id: '2', data: { capability: 'shared.sync' } } as Job<object>,
    ]);

    expect(skipped).toEqual({ skipped: 'MODULE_OFF' });
    expect(worked).toEqual({ done: true });
    expect(opsHandle).toHaveBeenCalledOnce();
  });

  it('removes an unkeyed schedule an earlier release left on a declared queue', async () => {
    const { supervisor, boss, schedules } = setup();
    schedules.push({ name: 'ops.work', key: '', cron: '0 3 * * *', timezone: 'UTC', data: {} });

    await supervisor.reconcile();

    expect(boss.unschedule).toHaveBeenCalledWith('ops.work', '');
    expect(schedules.filter((s) => s.name === 'ops.work').map((s) => s.key)).toEqual(['nightly']);
  });

  it('keeps the worker starting when a queue fails at the first reconcile (N1)', async () => {
    const { supervisor, boss } = setup();
    const real = boss.getSchedules.getMockImplementation();
    boss.getSchedules.mockImplementation((name: string) =>
      name === 'shared.work'
        ? Promise.reject(new Error('connection lost'))
        : (real as (n: string) => Promise<never>)(name),
    );
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    await expect(supervisor.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Reconciling module jobs at worker start failed'),
    );
    expect(boss.work.mock.calls.map((call) => call[0])).toContain('ops.work');
  });

  it('stops capabilities even when one queue fails, then fails the reconcile', async () => {
    const { supervisor, boss, states, onDisable } = setup();
    await supervisor.reconcile();
    states.set('ops.queue', STOPPED);
    const real = boss.getSchedules.getMockImplementation();
    boss.getSchedules.mockImplementation((name: string) =>
      name === 'shared.work'
        ? Promise.reject(new Error('connection lost'))
        : (real as (n: string) => Promise<never>)(name),
    );

    await expect(supervisor.reconcile()).rejects.toThrow('Reconciling shared.work failed');
    expect(boss.offWork).toHaveBeenCalledWith('ops.work', { wait: false });
    expect(onDisable).toHaveBeenCalledOnce();
  });

  it('backfills each capability of a renewed bundle once for its gap (AC-19)', async () => {
    const { supervisor, boss, renewals } = setup();
    const gap = { from: '2027-04-14T22:00:00.000000Z', to: '2027-05-20T08:00:00.000000Z' };
    renewals.push({ bundle: 'operations', seq: '7', ...gap });
    const sentKeys = new Set<string>();
    boss.send.mockImplementation((...args: unknown[]) => {
      sentKeys.add((args[2] as { singletonKey: string }).singletonKey);
      return Promise.resolve('sent');
    });
    const findJobs = boss.findJobs.getMockImplementation() as (
      name: string,
      options: { data?: Record<string, unknown> },
    ) => Promise<{ id: string; data: Record<string, unknown> }[]>;
    boss.findJobs.mockImplementation((name, options) => {
      const key = (options as { key?: string }).key;
      if (name === 'platform.backfill' && key !== undefined && sentKeys.has(key)) {
        return Promise.resolve([{ id: 'old', data: {} }]);
      }
      return findJobs(name, options);
    });

    const first = await supervisor.reconcile();
    const second = await supervisor.reconcile();

    expect(first.backfills).toBe(1);
    expect(second.backfills).toBe(0);
    expect(boss.send).toHaveBeenCalledWith(
      'platform.backfill',
      { capability: 'ops.queue', ...gap, cause: 'renewed' },
      { singletonKey: 'renewed:ops.queue:7' },
    );
  });

  it('backfills no capability of a renewed bundle that is not on (AC-19)', async () => {
    const { supervisor, boss, renewals, states } = setup();
    states.set('ops.queue', { state: 'limited', before: '2027-04-14T22:00:00Z', reason: 'lapsed' });
    renewals.push({
      bundle: 'operations',
      seq: '7',
      from: '2027-04-14T22:00:00Z',
      to: '2027-05-20T08:00:00Z',
    });
    expect((await supervisor.reconcile()).backfills).toBe(0);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('keeps finished backfills 90 days, past the renewal window', async () => {
    const { supervisor, boss } = setup();
    await supervisor.onApplicationBootstrap();
    expect(boss.updateQueue).toHaveBeenCalledWith('platform.backfill', {
      deleteAfterSeconds: 90 * 24 * 60 * 60,
    });
  });

  it('starts even when setting the backfill retention fails', async () => {
    const { supervisor, boss } = setup();
    boss.updateQueue.mockRejectedValueOnce(new Error('no such queue'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await expect(supervisor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Setting the backfill queue's retention failed"),
    );
    expect(boss.work.mock.calls.map((call) => call[0])).toContain('ops.work');
  });

  it('asks for one stock out source task per episode of the reason (AC-29)', async () => {
    const { supervisor, states, openTask } = setup();
    // A Warehouse only install that never had a source: first seen not licensed, then licensed.
    states.set('stock.push', { state: 'off', reason: 'not_licensed', since: null });
    await supervisor.reconcile();
    expect(openTask).not.toHaveBeenCalled();
    states.set('stock.push', { state: 'read_only', reason: 'no_stock_out_source', since: null });
    await supervisor.reconcile();
    await supervisor.reconcile();
    expect(openTask).toHaveBeenCalledOnce();
    expect(openTask).toHaveBeenLastCalledWith({
      kind: 'stock_out_source_missing',
      key: 'stock.push:never',
      capability: 'stock.push',
    });

    // A source ran, then stopped at a lapse: a new episode, keyed on when it stopped.
    states.set('stock.push', { state: 'on', since: null });
    await supervisor.reconcile();
    const lapsed = '2027-04-14T22:00:00.000000Z';
    states.set('stock.push', { state: 'read_only', reason: 'no_stock_out_source', since: lapsed });
    await supervisor.reconcile();
    expect(openTask).toHaveBeenCalledTimes(2);
    expect(openTask).toHaveBeenLastCalledWith({
      kind: 'stock_out_source_missing',
      key: `stock.push:${lapsed}`,
      capability: 'stock.push',
    });

    // From one stop reason to this one counts as an entry too (a Warehouse lapse, then renewal).
    states.set('stock.push', { state: 'read_only', reason: 'lapsed', since: lapsed });
    await supervisor.reconcile();
    states.set('stock.push', { state: 'read_only', reason: 'no_stock_out_source', since: lapsed });
    await supervisor.reconcile();
    expect(openTask).toHaveBeenCalledTimes(3);
  });

  it('asks again with the same key at a worker restart, so the port opens nothing new', async () => {
    const first = setup();
    first.states.set('stock.push', {
      state: 'read_only',
      reason: 'no_stock_out_source',
      since: null,
    });
    await first.supervisor.reconcile();
    const restarted = setup();
    restarted.states.set('stock.push', {
      state: 'read_only',
      reason: 'no_stock_out_source',
      since: null,
    });
    await restarted.supervisor.reconcile();
    expect(first.openTask.mock.calls[0]).toEqual(restarted.openTask.mock.calls[0]);
  });

  it('keeps only the capability and the error name on a job whose handler throws', async () => {
    const { supervisor, boss, opsHandle } = setup();
    await supervisor.reconcile();
    const call = boss.work.mock.calls.find((c) => c[0] === 'ops.work') as unknown[];
    const dispatch = call[2] as (jobs: Job<object>[]) => Promise<unknown>;
    opsHandle.mockRejectedValueOnce(new TypeError('Failed query: select 1\nparams: secret'));

    const failure = await dispatch([{ id: '1', data: {} } as Job<object>]).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(JobHandlerFailed);
    expect((failure as Error).message).toBe('A job of ops.queue failed (TypeError)');
  });
});
