import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  capabilityOfStep,
  isRunnableState,
  type EffectiveState,
  type ModuleStates,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { z } from 'zod';
import type { Job, PgBoss } from 'pg-boss';
import { DATABASE } from '../../database/database.module.js';
import { describeError } from '../../database/pg-error.js';
import { LICENSE_CHANGED } from '../license/license-events.js';
import { CapabilityHooks } from '../modules/capability-hooks.js';
import { ModuleRegistry } from '../modules/module-registry.js';
import { ModuleStateService } from '../modules/module-state.service.js';
import { PlatformChangesListener } from '../settings/platform-changes-listener.js';
import {
  RECONCILE_MODULES_JOB,
  ReconcileModulesData,
  type ResumedGap,
} from '../settings/reconcile-modules.queue.js';
import { canonicalJson, SettingsService } from '../settings/settings.service.js';
import { defineQueue, stampJobData, type QueueDeclaration } from './job-declarations.js';
import { JobBoss } from './job-boss.js';
import { JobRegistry } from './job-registry.js';

/**
 * The platform's backfill queue (spec 0009, AC-11): one job per capability and gap, owned by the
 * core capability `platform.reconcile_modules` and carrying the backfilled capability in
 * `data.capability`, so the gate skips it if that capability stopped again.
 */
export const BACKFILL_JOB = defineQueue({
  name: 'platform.backfill',
  capability: 'platform.reconcile_modules',
  options: { policy: 'short', retryLimit: 2 },
  ownerHandlesAll: true,
});

/** The data of a backfill job. */
const BackfillData = z.object({
  capability: z.string(),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

/** At most this many queued jobs are read per `findJobs` page when cancelling. */
const CANCEL_PAGE = 1_000;
/**
 * A cancel loop reads pages until one comes back empty; past this many it stops with a warning,
 * so a queue whose jobs cannot be cancelled never spins it (the next reconcile goes on).
 */
export const CANCEL_MAX_PAGES = 1_000;

/**
 * What pg-boss keeps on a job whose handler or hook threw: the capability and the error's name
 * only, never its message, which can carry a failed query's params (security review m3, 2). The
 * full, safe text is logged by `describeError` before this is thrown.
 */
export class JobHandlerFailed extends Error {
  /** Takes the capability whose job failed and the name of what it threw. */
  constructor(capability: string, cause: string) {
    super(`A job of ${capability} failed (${cause})`);
    this.name = 'JobHandlerFailed';
  }
}

/** What one reconcile did, for tests and the job's output. */
export interface ReconcileReport {
  stopped: string[];
  backfills: number;
}

/**
 * Keeps the worker's pg-boss queues, workers, and cron schedules in line with the module and
 * capability states (spec 0009, AC-10, AC-11, AC-12, AC-22). It reconciles at worker start, on
 * every `NOTIFY ssd_platform_changed` (a settings key, or `license` when a check moved a phase),
 * on `LicenseChanged` in this process, and in the `platform.reconcile_modules` job; reconciles run
 * one at a time and a burst folds into one. For each declared queue: while its owning capability
 * is runnable (`on` or `limited`), its workers run and each schedule whose capability (and step)
 * is runnable is registered in the current `timezone` setting (so a time zone change re registers
 * every cron, review R11); a schedule that is not wanted is removed (`unschedule`). When the owner
 * stops, every schedule goes, its workers stop (`offWork`, without waiting: work in flight
 * finishes), and its queued jobs are cancelled; on a shared queue whose owner still runs, only a
 * stopped capability's (or step's) schedules and queued jobs go (`findJobs` by `data`, paged, then
 * `cancel`). A capability that stops has its waiting outbound commands failed with `MODULE_OFF`
 * (a step that stops, `STEP_OFF`) and its `onDisable` hook called with the reason; both run again
 * at a worker start while it stays stopped, so they must be idempotent. A module turned back on
 * gets one backfill job per capability with a `backfill` hook for the gap it was off (singleton
 * key on the gap); nothing cancelled is replayed. Every job runs through the gate: a job of a
 * capability (or step) that is not runnable completes with `{ skipped: 'MODULE_OFF' }` (or
 * `STEP_OFF`), never `failed`. Worker only.
 */
@Injectable()
export class ModuleJobSupervisor
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('ModuleJobs');
  private readonly working = new Set<string>();
  private readonly lastRunnable = new Map<string, boolean>();
  private chain: Promise<unknown> = Promise.resolve();
  private requested: Promise<ReconcileReport | undefined> | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopping = false;

  /** Takes the job client and registry, the module registry and states, settings, hooks, and the listener. */
  constructor(
    @Inject(JobBoss) private readonly jobBoss: JobBoss,
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(ModuleStateService) private readonly states: ModuleStateService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(CapabilityHooks) private readonly hooks: CapabilityHooks,
    @Inject(PlatformChangesListener) private readonly listener: PlatformChangesListener,
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
  ) {}

  /** Declares the platform's own queues: the reconcile job and the backfill job. */
  onModuleInit(): void {
    this.jobs.declareQueue(RECONCILE_MODULES_JOB);
    this.jobs.declareHandler({
      queue: RECONCILE_MODULES_JOB.name,
      capability: RECONCILE_MODULES_JOB.capability,
      handle: async (job) => {
        const { resumed } = ReconcileModulesData.parse(job.data);
        return { ...(await this.reconcile(resumed)) };
      },
    });
    this.jobs.declareQueue(BACKFILL_JOB);
    this.jobs.declareHandler({
      queue: BACKFILL_JOB.name,
      capability: BACKFILL_JOB.capability,
      handle: async (job) => {
        const { capability, from, to } = BackfillData.parse(job.data);
        const backfill = this.hooks.of(capability).backfill;
        if (!backfill) return { skipped: 'NO_BACKFILL' };
        await backfill({ from, to });
        return { capability, from, to };
      },
    });
  }

  /**
   * Starts the client, creates every declared queue, listens for changes, and reconciles. A
   * reconcile that fails here is logged and the worker keeps running (security re-review m3, N1):
   * a crash would only restart the worker into the same failure, while the reconcile job's retries
   * and the next `NOTIFY` try again. A client or queue that cannot start still stops the start.
   */
  async onApplicationBootstrap(): Promise<void> {
    for (const queue of this.jobs.queues()) await this.jobBoss.ensureQueue(queue);
    this.unsubscribe = this.listener.subscribe(() => this.request());
    await this.reconcile().catch((error: unknown) => {
      this.logger.error(`Reconciling module jobs at worker start failed: ${describeError(error)}`);
    });
  }

  /** Stops reconciling; the client itself is stopped by `JobBoss`. */
  onApplicationShutdown(): void {
    this.stopping = true;
    this.unsubscribe?.();
  }

  /** A license check in this process moved a phase. */
  @OnEvent(LICENSE_CHANGED)
  licenseChanged(): void {
    this.request();
  }

  /**
   * Asks for a reconcile soon; requests made before it starts fold into it, requests made while it
   * runs queue one more. Never throws: a failed reconcile is logged.
   */
  request(): void {
    this.requested ??= this.enqueue(() => {
      this.requested = undefined;
      return this.reconcileOnce();
    }).catch((error: unknown) => {
      this.logger.error(`Reconciling module jobs failed: ${describeError(error)}`);
      return undefined;
    });
  }

  /** Reconciles now (after any reconcile in progress), with a resumed module's gap when given. */
  reconcile(resumed?: ResumedGap): Promise<ReconcileReport> {
    return this.enqueue(() => this.reconcileOnce(resumed));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcileOnce(resumed?: ResumedGap): Promise<ReconcileReport> {
    const report: ReconcileReport = { stopped: [], backfills: 0 };
    if (this.stopping) return report;
    const boss = await this.jobBoss.start();
    const states = await this.states.states({ fresh: true });
    const runnable = (key: string): boolean =>
      this.registry.alwaysOn(key) || isRunnableState(stateIn(states, key));
    const { timezone } = await this.settings.read(['timezone'], this.connection.db);
    // One queue that fails never keeps the others, or the stop of a capability, from happening
    // (security review m3, 5); the reconcile still fails at the end, so its job retries.
    const failed: string[] = [];
    for (const queue of this.jobs.queues()) {
      try {
        await this.reconcileQueue(boss, queue, runnable, timezone);
      } catch (error) {
        failed.push(queue.name);
        this.logger.error(`Reconciling queue ${queue.name} failed: ${describeError(error)}`);
      }
    }
    report.stopped = await this.transitions(states, runnable);
    if (resumed) report.backfills = await this.backfill(boss, resumed, runnable);
    if (failed.length > 0) throw new Error(`Reconciling ${failed.join(', ')} failed`);
    return report;
  }

  private async reconcileQueue(
    boss: PgBoss,
    queue: QueueDeclaration,
    runnable: (key: string) => boolean,
    timezone: string,
  ): Promise<void> {
    const owner = runnable(queue.capability);
    const wanted = new Map(
      this.jobs
        .schedulesOf(queue.name)
        .filter(
          (s) => owner && runnable(s.capability) && (s.step === undefined || runnable(s.step)),
        )
        .map((s) => [s.key, s] as const),
    );
    const existing = await boss.getSchedules(queue.name);
    for (const schedule of existing) {
      if (!wanted.has(schedule.key)) await boss.unschedule(queue.name, schedule.key);
    }
    for (const schedule of wanted.values()) {
      const data = stampJobData(schedule.data, schedule.capability, schedule.step);
      const found = existing.find((e) => e.key === schedule.key);
      const same =
        found &&
        found.cron === schedule.cron &&
        found.timezone === timezone &&
        canonicalJson(found.data ?? {}) === canonicalJson(data);
      if (!same) {
        await boss.schedule(queue.name, schedule.cron, data, { tz: timezone, key: schedule.key });
      }
    }

    if (owner && !this.working.has(queue.name)) {
      await boss.work<object>(queue.name, { ...queue.work }, (jobs) => this.dispatch(queue, jobs));
      this.working.add(queue.name);
    } else if (!owner && this.working.has(queue.name)) {
      // Without waiting: a job in flight finishes; one fetched in the race meets the gate.
      await boss.offWork(queue.name, { wait: false });
      this.working.delete(queue.name);
    }

    if (!owner) {
      await this.cancelQueued(boss, queue.name);
      return;
    }
    const others = [
      ...this.jobs.capabilitiesOn(queue.name),
      ...(queue.ownerHandlesAll
        ? this.hooks.registered().filter((key) => this.hooks.of(key).backfill)
        : []),
    ].filter((capability) => capability !== queue.capability);
    for (const capability of new Set(others)) {
      if (!runnable(capability)) await this.cancelQueued(boss, queue.name, { capability });
    }
    for (const step of this.jobs.stepsOn(queue.name)) {
      if (!runnable(step)) await this.cancelQueued(boss, queue.name, { step });
    }
  }

  /**
   * Cancels the queued jobs of a queue (only those whose data contains `data`), page by page until
   * a page comes back empty; a warning at `CANCEL_MAX_PAGES` pages (security review m3, 8).
   */
  private async cancelQueued(boss: PgBoss, queue: string, data?: object): Promise<void> {
    for (let page = 0; page < CANCEL_MAX_PAGES; page += 1) {
      const found = await boss.findJobs(queue, {
        queued: true,
        limit: CANCEL_PAGE,
        ...(data && { data }),
      });
      if (found.length === 0) return;
      await boss.cancel(
        queue,
        found.map((job) => job.id),
      );
    }
    this.logger.warn(
      `Stopped cancelling queued jobs of ${queue} after ${CANCEL_MAX_PAGES} pages; the next reconcile goes on`,
    );
  }

  /**
   * Fails the waiting commands of every capability (`MODULE_OFF`) and step (`STEP_OFF`) that
   * stopped since the last reconcile (or is stopped at this worker's first), and calls each
   * stopped capability's `onDisable`. A failed hook is logged and tried again next time.
   */
  private async transitions(
    states: ModuleStates,
    runnable: (key: string) => boolean,
  ): Promise<string[]> {
    const stopped: string[] = [];
    for (const key of this.registry.capabilityKeys()) {
      const now = runnable(key);
      const before = this.lastRunnable.get(key);
      if (now || before === false) {
        this.lastRunnable.set(key, now);
        continue;
      }
      const state = stateIn(states, key);
      try {
        await this.hooks.failWaitingCommands(key, 'MODULE_OFF');
        const onDisable = this.hooks.of(key).onDisable;
        if (onDisable && (state.state === 'off' || state.state === 'read_only')) {
          await onDisable({ state: state.state, reason: state.reason });
        }
        this.lastRunnable.set(key, false);
        stopped.push(key);
      } catch (error) {
        this.logger.error(`Stopping ${key} failed and is tried again: ${describeError(error)}`);
      }
    }
    for (const [step, state] of states.steps) {
      const gate = capabilityOfStep(this.registry.modules(), step)?.capability.key;
      const now = isRunnableState(state);
      const before = this.lastRunnable.get(step);
      // A step whose capability stopped had its commands failed with MODULE_OFF already.
      if (now || before === false || gate === undefined || !runnable(gate)) {
        this.lastRunnable.set(step, now);
        continue;
      }
      try {
        await this.hooks.failWaitingCommands(gate, 'STEP_OFF', step);
        this.lastRunnable.set(step, false);
        stopped.push(step);
      } catch (error) {
        this.logger.error(`Stopping ${step} failed and is tried again: ${describeError(error)}`);
      }
    }
    return stopped;
  }

  /**
   * Enqueues one backfill job for each capability of the resumed module that declares a
   * `backfill` and runs again (AC-11, AC-27), keyed on the gap: a job with that key in any state
   * means it was enqueued before, so a second reconcile adds none.
   */
  private async backfill(
    boss: PgBoss,
    resumed: ResumedGap,
    runnable: (key: string) => boolean,
  ): Promise<number> {
    const module = this.registry.toggledModule(resumed.key);
    let sent = 0;
    for (const capability of module?.capabilities ?? []) {
      if (!this.hooks.of(capability.key).backfill || !runnable(capability.key)) continue;
      const key = `${capability.key}:${resumed.from}:${resumed.to}`;
      if ((await boss.findJobs(BACKFILL_JOB.name, { key, limit: 1 })).length > 0) continue;
      const id = await boss.send(
        BACKFILL_JOB.name,
        { capability: capability.key, from: resumed.from, to: resumed.to },
        { singletonKey: key },
      );
      if (id !== null) sent += 1;
    }
    return sent;
  }

  /**
   * The gate every job passes (AC-10, AC-21): the job's capability (its `data.capability`, else
   * the queue owner) must be runnable, and its step (`data.step`) too; otherwise the job completes
   * skipped. A `limited` capability's handler learns `before`.
   */
  private async dispatch(
    queue: QueueDeclaration,
    jobs: Job<object>[],
  ): Promise<object | undefined> {
    let output: object | undefined;
    for (const job of jobs) {
      const data = job.data as { capability?: unknown; step?: unknown } | null;
      const capability = typeof data?.capability === 'string' ? data.capability : queue.capability;
      const step = typeof data?.step === 'string' ? data.step : undefined;
      const handler = this.jobs.handlerFor(queue.name, capability);
      if (!handler) throw new Error(`No handler on ${queue.name} for ${capability}`);
      const state = this.registry.alwaysOn(capability)
        ? undefined
        : await this.states.stateOf(capability);
      if (state && !isRunnableState(state)) {
        output = { skipped: 'MODULE_OFF' };
        continue;
      }
      if (step !== undefined && !(await this.states.isRunnable(step))) {
        output = { skipped: 'STEP_OFF' };
        continue;
      }
      try {
        output = await handler.handle(job, {
          before: state?.state === 'limited' ? state.before : null,
        });
      } catch (error) {
        this.logger.warn(`A job of ${capability} on ${queue.name} failed: ${describeError(error)}`);
        throw new JobHandlerFailed(capability, error instanceof Error ? error.name : 'error');
      }
    }
    return output;
  }
}

/** A capability's or step's state in a snapshot; unknown keys read as `off`. */
function stateIn(states: ModuleStates, key: string): EffectiveState {
  return (
    states.capabilities.get(key) ??
    states.steps.get(key) ?? { state: 'off', reason: 'not_licensed', since: null }
  );
}
