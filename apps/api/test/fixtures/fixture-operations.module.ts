import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Post,
  type OnModuleInit,
} from '@nestjs/common';
import {
  defineModule,
  MODULE_REGISTRY,
  type ModuleDefinition,
  type OffImpactCommands,
  type OffImpactInFlight,
  type OffImpactPartnerStock,
  type StopReason,
} from '@ssdashboard/contracts';
import { AnyHat } from '../../src/platform/access/permission.decorator.js';
import { Audience } from '../../src/platform/audience/audience.decorator.js';
import { defineQueue } from '../../src/platform/jobs/job-declarations.js';
import { JobRegistry } from '../../src/platform/jobs/job-registry.js';
import { CapabilityHooks } from '../../src/platform/modules/capability-hooks.js';
import { moduleHttpError } from '../../src/platform/modules/module.errors.js';
import { ModuleStateService } from '../../src/platform/modules/module-state.service.js';
import {
  RequiresCapability,
  RequiresModule,
} from '../../src/platform/modules/requires-module.decorator.js';
import { PlatformModule } from '../../src/platform/platform.module.js';

/**
 * The fixture Operations module of spec 0009 task 19 (AC-10, AC-11, AC-28, AC-30), and a fixture
 * core module owning a shared queue with a Warehouse capability on it. Test only: its rows join
 * the registry through `MODULE_ROWS` (`FIXTURE_MODULE_ROWS`), never `MODULE_REGISTRY`.
 */
export const FIXTURE_MODULES: readonly ModuleDefinition[] = [
  defineModule({
    key: 'fixtureops',
    bundle: 'operations',
    toggle: true,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'fixtureops.queue',
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'fixtureops.finish',
        bundle: 'operations',
        kind: 'write',
        windDown: 'until_closed',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'fixtureops.sales_days',
        bundle: 'operations',
        kind: 'write',
        windDown: 'until_closed',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
  // A toggleable module that requires the fixture module (AC-12, MODULE_REQUIRED_BY).
  defineModule({
    key: 'fixturedependant',
    bundle: 'operations',
    toggle: true,
    requires: ['fixtureops'],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [],
  }),
  // A toggleable Warehouse module (AC-12, NOT_LICENSED on an install without Warehouse).
  defineModule({
    key: 'fixturewarehouse',
    bundle: 'warehouse',
    toggle: true,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [],
  }),
  defineModule({
    key: 'fixturecore',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'fixturecore.sync',
        bundle: 'core',
        kind: 'read',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'fixturecore.push',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
];

/** The registry rows a fixture suite runs with: today's modules plus the fixtures. */
export const FIXTURE_MODULE_ROWS: readonly ModuleDefinition[] = [
  ...MODULE_REGISTRY,
  ...FIXTURE_MODULES,
];

/** The fixture module's own queue, with a cron schedule. */
export const FIXTURE_QUEUE = defineQueue({
  name: 'fixture.operations',
  capability: 'fixtureops.queue',
  options: { retryLimit: 0 },
});
/** The key of its schedule. */
export const FIXTURE_SCHEDULE_KEY = 'fixture-sweep';

/** The shared queue, owned by the core capability, with a Warehouse capability's jobs on it. */
export const SHARED_QUEUE = defineQueue({
  name: 'fixture.shared',
  capability: 'fixturecore.sync',
  options: { retryLimit: 0 },
});
/** The core schedule of the shared queue. */
export const SHARED_CORE_KEY = 'fixture-core-sweep';
/** The Warehouse capability's schedule on the shared queue. */
export const SHARED_PUSH_KEY = 'fixture-push';

/** One fixture outbound command. */
export interface FixtureCommand {
  id: string;
  capability: string;
  kind: string;
  state: 'waiting' | 'failed';
  reason: string | null;
}

/**
 * What the fixture records and answers, shared by the api and worker contexts of one test
 * process. A suite resets it in `beforeAll`.
 */
export const fixtureStore = {
  commands: [] as FixtureCommand[],
  disabled: [] as { capability: string; state: string; reason: StopReason }[],
  backfills: [] as { capability: string; from: string; to: string }[],
  handled: [] as { queue: string; capability: string; id: string }[],
  openFinish: 0,
  inFlight: [] as OffImpactInFlight[],
  partnerStock: [] as OffImpactPartnerStock[],
  /** Empties every list and count. */
  reset(): void {
    this.commands = [];
    this.disabled = [];
    this.backfills = [];
    this.handled = [];
    this.openFinish = 0;
    this.inFlight = [];
    this.partnerStock = [];
  },
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Registers the fixture hooks and the fixture outbound command port, in any context. */
@Injectable()
export class FixtureHooks implements OnModuleInit {
  /** Takes the capability hooks. */
  constructor(@Inject(CapabilityHooks) private readonly hooks: CapabilityHooks) {}

  /** Registers every fixture hook. */
  onModuleInit(): void {
    this.hooks.register('fixtureops.queue', {
      onDisable: (stop) => {
        fixtureStore.disabled.push({ capability: 'fixtureops.queue', ...stop });
        return Promise.resolve();
      },
      backfill: (gap) => {
        fixtureStore.backfills.push({ capability: 'fixtureops.queue', ...gap });
        return Promise.resolve();
      },
      offImpact: () =>
        Promise.resolve({
          inFlight: fixtureStore.inFlight,
          partnerStock: fixtureStore.partnerStock,
        }),
    });
    this.hooks.register('fixtureops.finish', {
      openItems: () => Promise.resolve(fixtureStore.openFinish),
    });
    this.hooks.register('fixtureops.sales_days', {
      openItems: () => Promise.resolve(fixtureStore.openFinish),
    });
    this.hooks.registerCommands({
      failWaitingCommands: (capability, reason) => {
        let failed = 0;
        for (const command of fixtureStore.commands) {
          if (command.capability === capability && command.state === 'waiting') {
            command.state = 'failed';
            command.reason = reason;
            failed += 1;
          }
        }
        return Promise.resolve(failed);
      },
      waitingCommands: (capability) => {
        const counts = new Map<string, number>();
        for (const command of fixtureStore.commands) {
          if (command.capability === capability && command.state === 'waiting') {
            counts.set(command.kind, (counts.get(command.kind) ?? 0) + 1);
          }
        }
        const rows: OffImpactCommands[] = [...counts].map(([kind, count]) => ({ kind, count }));
        return Promise.resolve(rows);
      },
    });
  }
}

/** Declares the fixture queues, schedules, and handlers (worker only). */
@Injectable()
export class FixtureJobs implements OnModuleInit {
  /** Takes the job registry. */
  constructor(@Inject(JobRegistry) private readonly jobs: JobRegistry) {}

  /** Declares the fixture module's queue and the shared queue. */
  onModuleInit(): void {
    const record =
      (queue: string, capability: string) => async (job: { id: string; data: object }) => {
        const slow = (job.data as { slowMs?: unknown }).slowMs;
        if (typeof slow === 'number') await pause(slow);
        fixtureStore.handled.push({ queue, capability, id: job.id });
        return { handled: job.id };
      };
    this.jobs.declareQueue(FIXTURE_QUEUE);
    this.jobs.declareSchedule({
      queue: FIXTURE_QUEUE.name,
      key: FIXTURE_SCHEDULE_KEY,
      capability: FIXTURE_QUEUE.capability,
      cron: '0 4 * * *',
    });
    this.jobs.declareHandler({
      queue: FIXTURE_QUEUE.name,
      capability: FIXTURE_QUEUE.capability,
      handle: record(FIXTURE_QUEUE.name, FIXTURE_QUEUE.capability),
    });
    this.jobs.declareQueue(SHARED_QUEUE);
    this.jobs.declareSchedule({
      queue: SHARED_QUEUE.name,
      key: SHARED_CORE_KEY,
      capability: 'fixturecore.sync',
      cron: '0 3 * * *',
    });
    this.jobs.declareSchedule({
      queue: SHARED_QUEUE.name,
      key: SHARED_PUSH_KEY,
      capability: 'fixturecore.push',
      cron: '0 2 * * *',
    });
    for (const capability of ['fixturecore.sync', 'fixturecore.push']) {
      this.jobs.declareHandler({
        queue: SHARED_QUEUE.name,
        capability,
        handle: record(SHARED_QUEUE.name, capability),
      });
    }
  }
}

/**
 * The fixture module's routes (staff, any hat): a read, new work, finishing a record opened at a
 * given instant (`limited` work, AC-28), and recording a sales day (`limited` work scoped by a
 * business date, as `consignment.sales_ingestion` is, wave 1 review W1).
 */
@Audience('staff')
@AnyHat()
@RequiresModule('fixtureops')
@Controller('fixture-operations')
export class FixtureOperationsController {
  /** Takes the module state service. */
  constructor(@Inject(ModuleStateService) private readonly states: ModuleStateService) {}

  /** A read, kept while the module is read only. */
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  /**
   * New work at module level with no `assertOn` of its own: only the gate stands in front of it,
   * which must refuse it once the module is not `on`, even while a finishing capability is
   * `limited` (a module is never `limited`, code review m3, finding 1).
   */
  @Post('records')
  @HttpCode(HttpStatus.OK)
  create(): { created: true } {
    return { created: true };
  }

  /** Finishes a record opened at `openedAt` (409 MODULE_LIMITED for a newer one). */
  @Post('finish')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability('fixtureops.finish')
  async finish(@Body() body: { openedAt: string }): Promise<{ finished: true }> {
    try {
      await this.states.assertMayFinish('fixtureops.finish', body.openedAt);
    } catch (error) {
      throw moduleHttpError(error) ?? error;
    }
    return { finished: true };
  }

  /** Records the sales of `salesDay` (judged by the day, never by when it is recorded). */
  @Post('sales-days')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability('fixtureops.sales_days')
  async salesDay(@Body() body: { salesDay: string }): Promise<{ recorded: true }> {
    try {
      await this.states.assertMayFinish('fixtureops.sales_days', `${body.salesDay}T00:00:00Z`);
    } catch (error) {
      throw moduleHttpError(error) ?? error;
    }
    return { recorded: true };
  }
}

/** The api side of the fixture: its routes and hooks. */
@Module({
  imports: [PlatformModule],
  controllers: [FixtureOperationsController],
  providers: [FixtureHooks],
})
export class FixtureOperationsModule {}

/** The worker side of the fixture: its hooks and jobs. */
@Module({ imports: [PlatformModule], providers: [FixtureHooks, FixtureJobs] })
export class FixtureOperationsWorkerModule {}
