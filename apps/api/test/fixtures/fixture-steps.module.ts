import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import {
  defineModule,
  defineSetting,
  MODULE_REGISTRY,
  type ModuleDefinition,
  type SettingDefinition,
} from '@ssdashboard/contracts';
import { z } from 'zod';
import { defineQueue } from '../../src/platform/jobs/job-declarations.js';
import { JobRegistry } from '../../src/platform/jobs/job-registry.js';
import { CapabilityHooks } from '../../src/platform/modules/capability-hooks.js';
import { ModuleStateService } from '../../src/platform/modules/module-state.service.js';
import { PlatformModule } from '../../src/platform/platform.module.js';

/** The fixture step that sends to customers: gates `fixturesteps.send`. */
export const SEND_STEP = 'step.fixture_send';
/** The fixture step that pushes stock: gates `fixturesteps.push`, which has no stock out source. */
export const PUSH_STEP = 'step.fixture_push';
/** The fixture step of a Warehouse capability, on an install licensed for Operations only. */
export const STOCK_STEP = 'step.fixture_stock';
/** The feature precondition of the stock step, which always fails. */
export const STOCK_READY = 'FIXTURE_STOCK_NOT_READY';
/** The feature precondition of the send step, with the facts it hands the dialog. */
export const SEND_READY = 'FIXTURE_SEND_READY';
/** The feature precondition of the push step, which always fails. */
export const PUSH_READY = 'FIXTURE_PUSH_NOT_READY';

/**
 * The fixture module of spec 0009 task 24 (AC-21, AC-27, AC-29): an Operations module whose
 * `send` capability is gated by an executing step with a feature precondition, and whose `push`
 * capability waits for a stock out source (an empty `requiresOneOf`, so it is `read_only` with
 * `no_stock_out_source`) and is gated by a step with a precondition that always fails, and a
 * Warehouse `stock` capability whose step fails its precondition too (the suite licenses Operations
 * only, so it proves `NOT_LICENSED` is answered first). Test only:
 * its rows join through `MODULE_ROWS` (`STEP_MODULE_ROWS`) and its steps through
 * `STEP_SETTING_ROWS` (`STEP_SETTINGS`), the fixture path real steps never take: a real step is an
 * entry of the settings registry in `@ssdashboard/contracts`, landing with its executor.
 */
export const STEP_MODULES: readonly ModuleDefinition[] = [
  defineModule({
    key: 'fixturesteps',
    bundle: 'operations',
    toggle: true,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'fixturesteps.send',
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        steps: [SEND_STEP],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'fixturesteps.push',
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        requiresOneOf: [],
        workOf: [],
        steps: [PUSH_STEP],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'fixturesteps.stock',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        steps: [STOCK_STEP],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
];

/** The registry rows the steps suite runs with: today's modules plus the fixture. */
export const STEP_MODULE_ROWS: readonly ModuleDefinition[] = [...MODULE_REGISTRY, ...STEP_MODULES];

/** One fixture step entry: an executing step, default off, reason required (AC-21). */
function stepSetting(
  key: string,
  notifiesCustomer: boolean,
  bundle: SettingDefinition['bundle'] = 'operations',
): SettingDefinition {
  return defineSetting({
    key,
    schema: z.boolean(),
    default: false,
    bundle,
    group: 'automations',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'executing_step',
    notifiesCustomer,
    label: 'settings.entries.operationsWindDownDays.label',
    description: 'settings.entries.operationsWindDownDays.description',
  });
}

/** The two fixture steps' settings entries. */
export const STEP_SETTINGS: readonly SettingDefinition[] = [
  stepSetting(SEND_STEP, true),
  stepSetting(PUSH_STEP, false),
  stepSetting(STOCK_STEP, false, 'warehouse'),
];

/** The send capability's queue; its jobs carry the send step (`data.step`). */
export const SEND_QUEUE = defineQueue({
  name: 'fixture.steps.send',
  capability: 'fixturesteps.send',
  options: { retryLimit: 0 },
});

/** One record the send step might act on, and the instant of its triggering event. */
export interface StepRecord {
  id: string;
  eventAt: string;
}

/** One fixture outbound command of the send step. */
export interface StepCommand {
  id: string;
  recordId: string;
  state: 'waiting' | 'failed' | 'sent';
  reason: string | null;
}

/**
 * What the fixture holds and records, shared by the api and worker contexts of the test process.
 * The suite resets it in `beforeAll`.
 */
export const stepStore = {
  /** Whether the send step's feature precondition passes. */
  sendReady: false,
  records: [] as StepRecord[],
  commands: [] as StepCommand[],
  handled: [] as { id: string; acted: string[] }[],
  /** Empties every list and resets the flag. */
  reset(): void {
    this.sendReady = false;
    this.records = [];
    this.commands = [];
    this.handled = [];
  },
};

/**
 * Registers the steps' feature preconditions and the outbound command port of the fixture, in
 * any context. The send precondition passes while `stepStore.sendReady`, with a fact of counts;
 * the push precondition never passes.
 */
@Injectable()
export class StepFixtureHooks implements OnModuleInit {
  /** Takes the capability hooks. */
  constructor(@Inject(CapabilityHooks) private readonly hooks: CapabilityHooks) {}

  /** Registers the preconditions and the command port. */
  onModuleInit(): void {
    this.hooks.registerPreconditions(SEND_STEP, [
      {
        code: SEND_READY,
        check: () =>
          Promise.resolve(
            stepStore.sendReady
              ? {
                  ok: true as const,
                  facts: [
                    {
                      label: 'settings.entries.operationsWindDownDays.label',
                      values: { stores: 2, variants: 140 },
                    },
                  ],
                }
              : { ok: false as const },
          ),
      },
    ]);
    this.hooks.registerPreconditions(PUSH_STEP, [
      { code: PUSH_READY, check: () => Promise.resolve({ ok: false as const }) },
    ]);
    this.hooks.registerPreconditions(STOCK_STEP, [
      { code: STOCK_READY, check: () => Promise.resolve({ ok: false as const }) },
    ]);
    this.hooks.registerCommands({
      failWaitingCommands: (_capability, reason, step) => {
        let failed = 0;
        if (step !== SEND_STEP && step !== undefined) return Promise.resolve(0);
        for (const command of stepStore.commands) {
          if (command.state === 'waiting') {
            command.state = 'failed';
            command.reason = reason;
            failed += 1;
          }
        }
        return Promise.resolve(failed);
      },
      waitingCommands: () =>
        Promise.resolve([
          {
            kind: 'fixture.send',
            count: stepStore.commands.filter((c) => c.state === 'waiting').length,
          },
        ]),
    });
  }
}

/**
 * Declares the send queue and its handler (worker only). The handler acts on a record only when
 * the step acts on its triggering event now (`ModuleStateService.actsOn`, AC-27): at or after the
 * step's `since`, asked at the moment it would act.
 */
@Injectable()
export class StepFixtureJobs implements OnModuleInit {
  /** Takes the job registry and the module states. */
  constructor(
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(ModuleStateService) private readonly states: ModuleStateService,
  ) {}

  /** Declares the queue and the handler. */
  onModuleInit(): void {
    this.jobs.declareQueue(SEND_QUEUE);
    this.jobs.declareHandler({
      queue: SEND_QUEUE.name,
      capability: SEND_QUEUE.capability,
      handle: async (job) => {
        const ids = (job.data as { records?: string[] }).records ?? [];
        const acted: string[] = [];
        for (const record of stepStore.records.filter((r) => ids.includes(r.id))) {
          if (await this.states.actsOn(SEND_STEP, record.eventAt)) {
            stepStore.commands.push({
              id: `command-${record.id}`,
              recordId: record.id,
              state: 'sent',
              reason: null,
            });
            acted.push(record.id);
          }
        }
        stepStore.handled.push({ id: job.id, acted });
        return { acted };
      },
    });
  }
}

/** The api side of the fixture: the preconditions and the command port. */
@Module({ imports: [PlatformModule], providers: [StepFixtureHooks] })
export class StepFixtureModule {}

/** The worker side of the fixture: the hooks and the send queue. */
@Module({ imports: [PlatformModule], providers: [StepFixtureHooks, StepFixtureJobs] })
export class StepFixtureWorkerModule {}
