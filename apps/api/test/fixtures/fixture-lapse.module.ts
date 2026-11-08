import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  type OnModuleInit,
} from '@nestjs/common';
import {
  addDays,
  compareInstants,
  defineModule,
  defineSetting,
  inCarrierScope,
  MODULE_REGISTRY,
  type ModuleDefinition,
  type SettingDefinition,
} from '@ssdashboard/contracts';
import { z } from 'zod';
import { AnyHat } from '../../src/platform/access/permission.decorator.js';
import { Audience } from '../../src/platform/audience/audience.decorator.js';
import { defineQueue } from '../../src/platform/jobs/job-declarations.js';
import { JobRegistry } from '../../src/platform/jobs/job-registry.js';
import { LicenseService } from '../../src/platform/license/license.service.js';
import {
  CapabilityHooks,
  type PlatformTaskRequest,
} from '../../src/platform/modules/capability-hooks.js';
import { moduleHttpError } from '../../src/platform/modules/module.errors.js';
import { ModuleStateService } from '../../src/platform/modules/module-state.service.js';
import {
  RequiresCapability,
  RequiresModule,
} from '../../src/platform/modules/requires-module.decorator.js';
import { PlatformModule } from '../../src/platform/platform.module.js';
import { localDate } from '../../src/platform/settings/settings.service.js';

/**
 * The fixtures of spec 0009 task 23 (AC-17, AC-18, AC-19, AC-27, AC-28, AC-29): stand ins for the
 * carrier connector (a stock out source, the wind down sweep, the stock push), the orders module
 * (the confirmation queue, a write back gated by an executing step), carrier settlement (the
 * matching and the close out), consignment (partner sales ingestion by sales day and partner
 * period close out, sharing one open item count), and Warehouse transfers (receiving one
 * dispatched before a Warehouse lapse). Test only: the rows join the registry through
 * `MODULE_ROWS` (`LAPSE_MODULE_ROWS`) and the step through `STEP_SETTING_ROWS`.
 */
export const LAPSE_MODULES: readonly ModuleDefinition[] = [
  defineModule({
    key: 'lapsecarrier',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'lapsecarrier.new_shipments',
        bundle: 'operations',
        kind: 'read',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'lapsecarrier.mirror_reads',
        bundle: 'operations',
        kind: 'read',
        windDown: 'pre_lapse',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'lapsecarrier.stock_push',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'none',
        requiresOneOf: ['lapsecarrier.new_shipments'],
        workOf: ['stock.receive'],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
  defineModule({
    key: 'lapseorders',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'lapseorders.confirmation_queue',
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        workOf: ['orders.confirm'],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'lapseorders.write_back',
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        steps: ['step.lapse_write_back'],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
  defineModule({
    key: 'lapsesettle',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'lapsesettle.reconciliation',
        bundle: 'operations',
        kind: 'write',
        windDown: 'pre_lapse',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'lapsesettle.close_out',
        bundle: 'operations',
        kind: 'write',
        windDown: 'until_closed',
        workOf: ['settlement.work', 'settlement.close'],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
  defineModule({
    key: 'lapsepartner',
    bundle: 'operations',
    toggle: true,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'lapsepartner.sales_ingestion',
        bundle: 'operations',
        kind: 'write',
        windDown: 'until_closed',
        workOf: ['settlement.work'],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'lapsepartner.settlement_close_out',
        bundle: 'operations',
        kind: 'write',
        windDown: 'until_closed',
        workOf: ['settlement.work', 'settlement.close'],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
  defineModule({
    key: 'lapsestock',
    bundle: 'warehouse',
    toggle: true,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'lapsestock.transfers',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'none',
        workOf: ['stock.receive'],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'lapsestock.transfers_receive',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'until_closed',
        workOf: ['stock.receive'],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
];

/** The registry rows the lapse suite runs with: today's modules plus the lapse fixtures. */
export const LAPSE_MODULE_ROWS: readonly ModuleDefinition[] = [
  ...MODULE_REGISTRY,
  ...LAPSE_MODULES,
];

/** The fixture executing step, gating `lapseorders.write_back`. */
export const LAPSE_STEP = 'step.lapse_write_back';

/** Its settings entry: an executing step, default off, as every step is (AC-21). */
export const LAPSE_STEP_SETTINGS: readonly SettingDefinition[] = [
  defineSetting({
    key: LAPSE_STEP,
    schema: z.boolean(),
    default: false,
    bundle: 'operations',
    group: 'automations',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'executing_step',
    notifiesCustomer: false,
    label: 'settings.entries.operationsWindDownDays.label',
    description: 'settings.entries.operationsWindDownDays.description',
  }),
];

/** The confirmation queue (stops at the lapse), with a schedule. */
export const CONFIRMATION_QUEUE = defineQueue({
  name: 'lapse.confirmation',
  capability: 'lapseorders.confirmation_queue',
  options: { retryLimit: 0 },
});
/** The wind down sweep (keeps going for in scope deliveries), with a schedule. */
export const SWEEP_QUEUE = defineQueue({
  name: 'lapse.sweep',
  capability: 'lapsecarrier.mirror_reads',
  options: { retryLimit: 0 },
});
/** The stock push (waits for a stock out source and a confirmed preview), with a schedule. */
export const PUSH_QUEUE = defineQueue({
  name: 'lapse.stock_push',
  capability: 'lapsecarrier.stock_push',
  options: { retryLimit: 0 },
});
/** The write back, whose jobs carry the fixture step. */
export const WRITE_BACK_QUEUE = defineQueue({
  name: 'lapse.write_back',
  capability: 'lapseorders.write_back',
  options: { retryLimit: 0 },
});

/** The schedule keys, one per queue but the write back's. */
export const LAPSE_SCHEDULES = {
  confirmation: 'lapse-confirmation',
  sweep: 'lapse-sweep',
  push: 'lapse-stock-push',
} as const;

/** Cash states a pre lapse order goes through; the last three are final (AC-18). */
const FINAL_CASH = new Set(['reconciled', 'nothing_to_collect', 'prepaid']);

/** One fixture order with carrier cash. */
export interface LapseOrder {
  id: string;
  openedAt: string;
  cash: string;
}

/** One carrier delivery the sweep may follow. */
export interface LapseDelivery {
  id: string;
  carrierCreatedAt: string;
  orderConfirmedAt: string | null;
}

/** One carrier settlement period. */
export interface LapsePeriod {
  id: string;
  openedAt: string;
  fees: number;
  closed: boolean;
}

/** One consignment partner: its first stock day, latest closed period end, and reported days. */
export interface LapsePartner {
  id: string;
  firstStockDay: string;
  closedThrough: string | null;
  reported: Set<string>;
  closedPeriods: { start: string; end: string; amountOwed: string }[];
}

/** One Warehouse transfer between the brand's locations. */
export interface LapseTransfer {
  id: string;
  dispatchedAt: string;
  received: boolean;
}

/** One record an executing step might act on, and its triggering event. */
export interface LapseRecord {
  id: string;
  eventAt: string;
  backfilled?: boolean;
}

/**
 * What the lapse fixtures hold and record, shared by the api and worker contexts of the test
 * process. The suite resets it in `beforeAll`.
 */
export const lapseStore = {
  orders: [] as LapseOrder[],
  deliveries: [] as LapseDelivery[],
  periods: [] as LapsePeriod[],
  partners: [] as LapsePartner[],
  transfers: [] as LapseTransfer[],
  records: [] as LapseRecord[],
  commands: [] as { recordId: string; step: string }[],
  swept: [] as string[][],
  confirmations: [] as string[],
  pushes: [] as object[],
  disabled: [] as { capability: string; reason: string }[],
  backfills: [] as { capability: string; from: string; to: string; cause: string }[],
  tasks: [] as PlatformTaskRequest[],
  pushConfirmed: false,
  timezone: 'Africa/Cairo',
  /** Empties every list and flag. */
  reset(): void {
    this.orders = [];
    this.deliveries = [];
    this.periods = [];
    this.partners = [];
    this.transfers = [];
    this.records = [];
    this.commands = [];
    this.swept = [];
    this.confirmations = [];
    this.pushes = [];
    this.disabled = [];
    this.backfills = [];
    this.tasks = [];
    this.pushConfirmed = false;
  },
};

/**
 * The partners with unreported or unconfirmed sales days before the cut (AC-28, W1, re-check R1
 * and second re-check S1): counted from the day after the partner's latest closed period, or from
 * its first stock day when none is closed, so a period not created yet still counts.
 */
export function partnersWithOpenDays(before: string): number {
  const cutDay = localDate(new Date(before), lapseStore.timezone);
  let open = 0;
  for (const partner of lapseStore.partners) {
    let day = partner.closedThrough ? addDays(partner.closedThrough, 1) : partner.firstStockDay;
    let missing = false;
    while (day < cutDay) {
      if (!partner.reported.has(day)) missing = true;
      day = addDays(day, 1);
    }
    if (missing) open += 1;
  }
  return open;
}

/** Local 00:00 of a sales or period day in the suite's zone, as an instant with its offset. */
function dayStart(day: string): string {
  // Cairo is UTC+2 in April (summer time starts on the last Friday of April).
  return `${day}T00:00:00+02:00`;
}

/** Registers the lapse fixture hooks and the manager task port, in any context. */
@Injectable()
export class LapseHooks implements OnModuleInit {
  /** Takes the capability hooks. */
  constructor(@Inject(CapabilityHooks) private readonly hooks: CapabilityHooks) {}

  /** Registers every fixture hook. */
  onModuleInit(): void {
    this.hooks.register('lapsecarrier.new_shipments', {
      // Catches up mirror state only (AC-27): it marks gap records as imported by a backfill and
      // never makes a command.
      backfill: (gap) => {
        lapseStore.backfills.push({ capability: 'lapsecarrier.new_shipments', ...gap });
        for (const record of lapseStore.records) {
          const inGap =
            compareInstants(record.eventAt, gap.from) >= 0 &&
            compareInstants(record.eventAt, gap.to) < 0;
          if (inGap) record.backfilled = true;
        }
        return Promise.resolve();
      },
    });
    this.hooks.register('lapsecarrier.stock_push', {
      // W10: a push that stops for want of a source, or by a lapse, needs a new confirmed preview.
      onDisable: (stop) => {
        lapseStore.disabled.push({ capability: 'lapsecarrier.stock_push', reason: stop.reason });
        if (stop.reason === 'no_stock_out_source' || stop.reason === 'lapsed') {
          lapseStore.pushConfirmed = false;
        }
        return Promise.resolve();
      },
    });
    // Every Operations pre lapse capability counts, or the wind down never ends early (AC-18):
    // the sweep has nothing of its own to count.
    this.hooks.register('lapsecarrier.mirror_reads', { openItems: () => Promise.resolve(0) });
    this.hooks.register('lapsesettle.reconciliation', {
      openItems: () =>
        Promise.resolve(lapseStore.orders.filter((order) => !FINAL_CASH.has(order.cash)).length),
    });
    this.hooks.register('lapsesettle.close_out', {
      openItems: ({ before }) =>
        Promise.resolve(
          lapseStore.periods.filter(
            (period) => !period.closed && compareInstants(period.openedAt, before) < 0,
          ).length,
        ),
    });
    for (const capability of [
      'lapsepartner.sales_ingestion',
      'lapsepartner.settlement_close_out',
    ]) {
      this.hooks.register(capability, {
        openItems: ({ before }) => Promise.resolve(partnersWithOpenDays(before)),
      });
    }
    this.hooks.register('lapsestock.transfers_receive', {
      openItems: ({ before }) =>
        Promise.resolve(
          lapseStore.transfers.filter(
            (t) => !t.received && compareInstants(t.dispatchedAt, before) < 0,
          ).length,
        ),
    });
    this.hooks.registerTasks({
      open: (request) => {
        const open = lapseStore.tasks.some((t) => t.kind === request.kind && t.key === request.key);
        if (!open) lapseStore.tasks.push(request);
        return Promise.resolve();
      },
    });
  }
}

/** Declares the lapse fixture queues, schedules, and handlers (worker only). */
@Injectable()
export class LapseJobs implements OnModuleInit {
  /** Takes the job registry, the license (the wind down scope), and the module states. */
  constructor(
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(LicenseService) private readonly license: LicenseService,
    @Inject(ModuleStateService) private readonly states: ModuleStateService,
  ) {}

  /** Declares every fixture queue. */
  onModuleInit(): void {
    this.jobs.declareQueue(CONFIRMATION_QUEUE);
    this.jobs.declareSchedule({
      queue: CONFIRMATION_QUEUE.name,
      key: LAPSE_SCHEDULES.confirmation,
      capability: CONFIRMATION_QUEUE.capability,
      cron: '0 5 * * *',
    });
    this.jobs.declareHandler({
      queue: CONFIRMATION_QUEUE.name,
      capability: CONFIRMATION_QUEUE.capability,
      handle: (job) => {
        lapseStore.confirmations.push(job.id);
        return Promise.resolve({ handled: job.id });
      },
    });

    this.jobs.declareQueue(SWEEP_QUEUE);
    this.jobs.declareSchedule({
      queue: SWEEP_QUEUE.name,
      key: LAPSE_SCHEDULES.sweep,
      capability: SWEEP_QUEUE.capability,
      cron: '0 6 * * *',
    });
    this.jobs.declareHandler({
      queue: SWEEP_QUEUE.name,
      capability: SWEEP_QUEUE.capability,
      // Follows only the deliveries in the wind down scope (AC-18): one read of the cut, then the
      // pure rule per delivery.
      handle: async () => {
        const cut = await this.license.windDownScope();
        const followed = lapseStore.deliveries
          .filter((delivery) =>
            typeof cut === 'string' ? cut === 'not_lapsed' : inCarrierScope(delivery, cut),
          )
          .map((delivery) => delivery.id);
        lapseStore.swept.push(followed);
        return { followed };
      },
    });

    this.jobs.declareQueue(PUSH_QUEUE);
    this.jobs.declareSchedule({
      queue: PUSH_QUEUE.name,
      key: LAPSE_SCHEDULES.push,
      capability: PUSH_QUEUE.capability,
      cron: '0 7 * * *',
    });
    this.jobs.declareHandler({
      queue: PUSH_QUEUE.name,
      capability: PUSH_QUEUE.capability,
      handle: () => {
        const output = lapseStore.pushConfirmed ? { pushed: true } : { waiting: 'NEW_PREVIEW' };
        lapseStore.pushes.push(output);
        return Promise.resolve(output);
      },
    });

    this.jobs.declareQueue(WRITE_BACK_QUEUE);
    this.jobs.declareHandler({
      queue: WRITE_BACK_QUEUE.name,
      capability: WRITE_BACK_QUEUE.capability,
      // Acts only on records whose triggering event is at or after the step's `since` (AC-27).
      handle: async (job) => {
        const ids = (job.data as { records?: string[] }).records ?? [];
        const acted: string[] = [];
        for (const record of lapseStore.records.filter((r) => ids.includes(r.id))) {
          if (record.backfilled) continue;
          if (await this.states.actsOn(LAPSE_STEP, record.eventAt)) {
            lapseStore.commands.push({ recordId: record.id, step: LAPSE_STEP });
            acted.push(record.id);
          }
        }
        return { acted };
      },
    });
  }
}

/** Carrier settlement routes: cash states of an order, fee lines, and closing a period. */
@Audience('staff')
@AnyHat()
@RequiresModule('lapsesettle')
@Controller('lapse-settle')
export class LapseSettleController {
  /** Takes the module state service. */
  constructor(@Inject(ModuleStateService) private readonly states: ModuleStateService) {}

  /** Moves an order's cash state (the matching, `pre_lapse`): only orders opened before the cut. */
  @Post('orders/:id/cash')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability('lapsesettle.reconciliation')
  async cash(@Param('id') id: string, @Body() body: { cash: string }): Promise<{ cash: string }> {
    const order = lapseStore.orders.find((o) => o.id === id);
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND' });
    await this.finish('lapsesettle.reconciliation', order.openedAt);
    order.cash = body.cash;
    return { cash: order.cash };
  }

  /** Accounts a fee line on a period (close out, `until_closed`). */
  @Post('periods/:id/fees')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability('lapsesettle.close_out')
  async fee(@Param('id') id: string): Promise<{ fees: number }> {
    const period = this.period(id);
    await this.finish('lapsesettle.close_out', period.openedAt);
    period.fees += 1;
    return { fees: period.fees };
  }

  /** Closes a period (close out, `until_closed`). */
  @Post('periods/:id/close')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability('lapsesettle.close_out')
  async close(@Param('id') id: string): Promise<{ closed: true }> {
    const period = this.period(id);
    await this.finish('lapsesettle.close_out', period.openedAt);
    period.closed = true;
    return { closed: true };
  }

  private period(id: string): LapsePeriod {
    const period = lapseStore.periods.find((p) => p.id === id);
    if (!period) throw new NotFoundException({ code: 'NOT_FOUND' });
    return period;
  }

  private async finish(capability: string, openedAt: string): Promise<void> {
    try {
      await this.states.assertMayFinish(capability, openedAt);
    } catch (error) {
      throw moduleHttpError(error) ?? error;
    }
  }
}

/** Consignment routes: a sales day of a partner statement, and closing a partner period. */
@Audience('staff')
@AnyHat()
@RequiresModule('lapsepartner')
@Controller('lapse-partner')
export class LapsePartnerController {
  /** Takes the module state service. */
  constructor(@Inject(ModuleStateService) private readonly states: ModuleStateService) {}

  /** Records and confirms a partner's sales day, judged by the day, never by when it arrives. */
  @Post('sales-days')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability('lapsepartner.sales_ingestion')
  async salesDay(@Body() body: { partnerId: string; salesDay: string }): Promise<{ ok: true }> {
    await this.finish('lapsepartner.sales_ingestion', dayStart(body.salesDay));
    this.partner(body.partnerId).reported.add(body.salesDay);
    return { ok: true };
  }

  /** Closes a partner period with the amount owed, judged by its start date. */
  @Post('periods')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability('lapsepartner.settlement_close_out')
  async closePeriod(
    @Body() body: { partnerId: string; start: string; end: string; amountOwed: string },
  ): Promise<{ amountOwed: string }> {
    await this.finish('lapsepartner.settlement_close_out', dayStart(body.start));
    const partner = this.partner(body.partnerId);
    partner.closedPeriods.push({ start: body.start, end: body.end, amountOwed: body.amountOwed });
    partner.closedThrough = body.end;
    return { amountOwed: body.amountOwed };
  }

  private partner(id: string): LapsePartner {
    const partner = lapseStore.partners.find((p) => p.id === id);
    if (!partner) throw new NotFoundException({ code: 'NOT_FOUND' });
    return partner;
  }

  private async finish(capability: string, openedAt: string): Promise<void> {
    try {
      await this.states.assertMayFinish(capability, openedAt);
    } catch (error) {
      throw moduleHttpError(error) ?? error;
    }
  }
}

/** Warehouse transfer routes: receiving a transfer, judged by when it was dispatched. */
@Audience('staff')
@AnyHat()
@RequiresModule('lapsestock')
@Controller('lapse-stock')
export class LapseStockController {
  /** Takes the module state service. */
  constructor(@Inject(ModuleStateService) private readonly states: ModuleStateService) {}

  /** Receives a transfer (`until_closed`): only one dispatched before the Warehouse lapse. */
  @Post('transfers/:id/receive')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability('lapsestock.transfers_receive')
  async receive(@Param('id') id: string): Promise<{ received: true }> {
    const transfer = lapseStore.transfers.find((t) => t.id === id);
    if (!transfer) throw new NotFoundException({ code: 'NOT_FOUND' });
    try {
      await this.states.assertMayFinish('lapsestock.transfers_receive', transfer.dispatchedAt);
    } catch (error) {
      throw moduleHttpError(error) ?? error;
    }
    transfer.received = true;
    return { received: true };
  }
}

/** The api side of the lapse fixtures: their routes and hooks. */
@Module({
  imports: [PlatformModule],
  controllers: [LapseSettleController, LapsePartnerController, LapseStockController],
  providers: [LapseHooks],
})
export class LapseFixtureModule {}

/** The worker side of the lapse fixtures: their hooks and jobs. */
@Module({ imports: [PlatformModule], providers: [LapseHooks, LapseJobs] })
export class LapseFixtureWorkerModule {}
