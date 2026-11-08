import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  LicenseSummary,
  ModuleStatesResponse,
  PostLicenseAnswer,
  type LicensePayload,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobSender } from '../src/platform/jobs/job-sender.js';
import { ModuleJobSupervisor } from '../src/platform/jobs/module-job-supervisor.js';
import { WIND_DOWN_ENDED, type WindDownEnded } from '../src/platform/license/license-events.js';
import { PHASE_WATCH_CRON_TOKEN } from '../src/platform/license/license-check.job.js';
import { LICENSE_KEY_SET, LICENSE_KEYS } from '../src/platform/license/license-keys.js';
import { signLicense } from '../src/platform/license/license-signing.js';
import { LicenseService } from '../src/platform/license/license.service.js';
import { PlatformClock } from '../src/platform/license/platform-clock.js';
import { MODULE_ROWS, STEP_SETTING_ROWS } from '../src/platform/modules/module-registry.js';
import { ModuleStateService } from '../src/platform/modules/module-state.service.js';
import { WorkerModule } from '../src/worker.module.js';
import {
  CONFIRMATION_QUEUE,
  LAPSE_MODULE_ROWS,
  LAPSE_SCHEDULES,
  LAPSE_STEP,
  LAPSE_STEP_SETTINGS,
  LapseFixtureModule,
  LapseFixtureWorkerModule,
  lapseStore,
  PUSH_QUEUE,
  SWEEP_QUEUE,
  WRITE_BACK_QUEUE,
} from './fixtures/fixture-lapse.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { installOf, testVendorKey, trustTestKey } from './license-support.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0009 milestone 4, task 23 (AC-17, AC-18, AC-19, AC-27, AC-28, AC-29): the Operations lapse,
// its wind down, its end, and a renewal, then a Warehouse pilot license's lapse, through the real
// api and worker graphs on one scratch database with a fixed platform clock and the lapse
// fixtures (a carrier stand in with a stock out source, the wind down sweep and a stock push; a
// confirmation queue and a write back gated by an executing step; carrier settlement; consignment;
// Warehouse transfers). Every case of the Critical test scenario "Lapse".

devDatabaseUrl();

/** Operations expires on 2027-03-31: grace through 2027-04-14, the lapse at 2027-04-15 00:00. */
const OPERATIONS_EXPIRES_ON = '2027-03-31';
/** The pilot Warehouse grant expires on 2027-09-30: the Warehouse lapse is 2027-10-15. */
const WAREHOUSE_EXPIRES_ON = '2027-09-30';
/** Local 00:00 of 2027-04-15 in Cairo (UTC+2 until summer time starts on 30 April 2027). */
const LAPSED_AT = '2027-04-14T22:00:00.000000Z';

/** A cron that does not fire while the suite runs (00:00 on 1 January). */
const NEVER_DURING_A_RUN = '0 0 1 1 *';

/** Logger contexts whose error lines would mean the lapse handling failed. */
const QUIET = new Set(['ModuleJobs', 'ModuleState', 'Jobs', 'License']);
const errorLines: { context: string; message: string }[] = [];
const captureLogger: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  error: (message: unknown, ...rest: unknown[]) => {
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : '';
    errorLines.push({ context, message: String(message) });
  },
};

describe(
  'the lapse, the wind down, and a renewal (spec 0009 milestone 4)',
  { timeout: 300_000 },
  () => {
    const key = testVendorKey();
    const dir = mkdtempSync(join(tmpdir(), 'ssd-lapse-'));
    const file = join(dir, 'license.json');
    const clock = { at: new Date('2027-03-01T08:00:00.000Z') };
    const fixedClock = { now: () => Promise.resolve(clock.at) };
    /** `WindDownEnded` as the worker graph and the api graph each saw it. */
    const windDownEnds: WindDownEnded[] = [];
    const apiWindDownEnds: WindDownEnded[] = [];
    let api: InProcessApi;
    let worker: TestingModule;
    let manager: string;
    let support: string;
    let warehouse: string;
    let mediaBuyer: string;
    let partnerUser: string;

    const license = (
      over: Partial<LicensePayload>,
      install: { tenantId: string; clientCode: string },
    ) =>
      signLicense(
        {
          format: 1,
          licenseId: 'SSD-LAPSE-0001',
          clientCode: install.clientCode,
          tenantId: install.tenantId,
          bundles: ['warehouse', 'operations'],
          operationsExpiresOn: OPERATIONS_EXPIRES_ON,
          warehouseExpiresOn: WAREHOUSE_EXPIRES_ON,
          issuedOn: '2026-11-07',
          ...over,
        },
        key.entry.keyId,
        key.privateKey,
      );

    const sql = async <T extends object>(text: string, values: unknown[] = []): Promise<T[]> =>
      (await api.owner.pool.query<T>(text, values)).rows;
    const schedules = async (queue: string) =>
      (await sql<{ key: string }>(`SELECT key FROM pgboss.schedule WHERE name = $1`, [queue])).map(
        (row) => row.key,
      );
    const jobState = async (id: string | null) =>
      (
        await sql<{ state: string }>(`SELECT state::text AS state FROM pgboss.job WHERE id = $1`, [
          id,
        ])
      )[0]?.state;
    /**
     * The daily license check in the worker, as `LICENSE_CHECK_CRON` runs it, then a reconcile
     * awaited after the one its `LicenseChanged` started, so each case starts settled.
     */
    const check = async () => {
      const result = await worker.get(LicenseService).checkFile('daily');
      await worker.get(ModuleJobSupervisor).reconcile();
      refresh();
      return result;
    };
    /** Drops both processes' module state snapshots (the clock moved, or a fixture count did). */
    const refresh = () => {
      api.app.get(ModuleStateService).licenseChanged();
      worker.get(ModuleStateService).licenseChanged();
    };
    const at = (instant: string) => {
      clock.at = new Date(instant);
      refresh();
    };
    const modules = async (cookie = manager) => {
      const reply = await api.call(cookie, 'GET', '/api/platform/modules');
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return ModuleStatesResponse.parse(reply.body);
    };
    const stateOf = async (key: string) => {
      const all = await modules();
      return [...all.modules, ...all.capabilities].find((view) => view.key === key);
    };
    const summary = async () =>
      LicenseSummary.parse((await api.call(manager, 'GET', '/api/platform/license')).body);

    beforeAll(async () => {
      lapseStore.reset();
      errorLines.length = 0;
      api = await startInProcessApi(
        (builder) => {
          trustTestKey(builder, key);
          builder.overrideProvider(MODULE_ROWS).useValue(LAPSE_MODULE_ROWS);
          builder.overrideProvider(STEP_SETTING_ROWS).useValue(LAPSE_STEP_SETTINGS);
          builder.overrideProvider(PlatformClock).useValue(fixedClock);
        },
        {
          licenseFile: file,
          imports: [LapseFixtureModule],
          prepare: async (owner: DatabaseConnection) => {
            const { rows } = await owner.pool.query<{ id: string; client_code: string }>(
              'SELECT id::text AS id, client_code FROM install',
            );
            writeFileSync(
              file,
              license(
                {},
                { tenantId: rows[0]?.id as string, clientCode: rows[0]?.client_code as string },
              ),
            );
          },
        },
      );
      api.app.useLogger(captureLogger);
      // No wall clock schedule may record a check mid case: the daily check and the phase watch
      // fire only on 1 January at 00:00 (license-worker.e2e-spec.ts proves both are declared).
      // The api's close restores the env it found.
      process.env.LICENSE_CHECK_CRON = NEVER_DURING_A_RUN;
      worker = await Test.createTestingModule({ imports: [WorkerModule, LapseFixtureWorkerModule] })
        .overrideProvider(PHASE_WATCH_CRON_TOKEN)
        .useValue(NEVER_DURING_A_RUN)
        .overrideProvider(MODULE_ROWS)
        .useValue(LAPSE_MODULE_ROWS)
        .overrideProvider(STEP_SETTING_ROWS)
        .useValue(LAPSE_STEP_SETTINGS)
        .overrideProvider(LICENSE_KEY_SET)
        .useValue([...LICENSE_KEYS, key.entry])
        .overrideProvider(PlatformClock)
        .useValue(fixedClock)
        .compile();
      worker.useLogger(captureLogger);
      await worker.init();
      worker
        .get(EventEmitter2)
        .on(WIND_DOWN_ENDED, (event: WindDownEnded) => windDownEnds.push(event));
      api.app
        .get(EventEmitter2)
        .on(WIND_DOWN_ENDED, (event: WindDownEnded) => apiWindDownEnds.push(event));

      manager = await api.signIn((await api.addPerson(['manager'])).email);
      support = await api.signIn((await api.addPerson(['support'])).email);
      warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
      mediaBuyer = await api.signIn((await api.addPerson(['media_buyer'])).email);
      const account = await api.addParty('LAPSE-P1');
      partnerUser = await api.signIn(
        (await api.addPerson(['partner'], { partnerAccountId: account })).email,
      );

      // The fixtures' records: a partner whose period closes in the wind down, one whose next
      // period is not created at the cut, and a pre lapse settlement period with an order.
      const days = (from: string, to: string) => {
        const found: string[] = [];
        for (
          let d = new Date(`${from}T00:00:00Z`);
          d <= new Date(`${to}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + 1)
        ) {
          found.push(d.toISOString().slice(0, 10));
        }
        return new Set(found);
      };
      lapseStore.partners.push(
        {
          id: 'X',
          firstStockDay: '2027-03-01',
          closedThrough: '2027-03-31',
          reported: days('2027-04-01', '2027-04-13'),
          closedPeriods: [],
        },
        {
          id: 'Y',
          firstStockDay: '2027-03-01',
          closedThrough: '2027-03-31',
          reported: days('2027-04-01', '2027-04-10'),
          closedPeriods: [],
        },
      );
    });

    afterAll(async () => {
      await worker?.close();
      await api?.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('warns the manager on days 30, 14, and 7 before expiry, and staff from 7 days before the lapse (AC-17)', async () => {
      const service = api.app.get(LicenseService);
      for (const [day, level] of [
        ['2027-03-01', 'info'],
        ['2027-03-17', 'info'],
        ['2027-03-24', 'warning'],
      ] as const) {
        const operations = (await service.notice(day)).find((n) => n.bundle === 'operations');
        expect(operations, day).toMatchObject({
          phase: 'expiring',
          level,
          inReport: true,
          lapsesOn: '2027-04-15',
          lapsesAt: LAPSED_AT,
          windDownEndsOn: '2027-06-14',
        });
        // The stock push stops too: its only stock out source is an Operations capability.
        expect(operations?.stops).toEqual([
          'lapsecarrier.new_shipments',
          'lapsecarrier.stock_push',
          'lapseorders.confirmation_queue',
          'lapseorders.write_back',
        ]);
        expect(operations?.continues).toEqual([
          {
            capability: 'lapsecarrier.mirror_reads',
            until: 'wind_down_end',
            untilOn: '2027-06-14',
          },
          {
            capability: 'lapsesettle.reconciliation',
            until: 'wind_down_end',
            untilOn: '2027-06-14',
          },
          { capability: 'lapsesettle.close_out', until: 'open_items_closed', untilOn: null },
          { capability: 'lapsepartner.sales_ingestion', until: 'open_items_closed', untilOn: null },
          {
            capability: 'lapsepartner.settlement_close_out',
            until: 'open_items_closed',
            untilOn: null,
          },
        ]);
      }
      // Not in the daily report between those days.
      expect(
        (await service.notice('2027-03-02')).find((n) => n.bundle === 'operations')?.inReport,
      ).toBe(false);

      for (const day of ['2027-03-01T08:00:00Z', '2027-03-17T08:00:00Z', '2027-03-24T08:00:00Z']) {
        at(day);
        const seen = await modules();
        expect(seen.licenseNotices?.some((n) => n.bundle === 'operations')).toBe(true);
        // The lapse is more than 7 days away: no staff notice yet.
        expect((await modules(support)).staffNotices).toEqual([]);
      }

      // Seven days before the lapse (day 8 of grace): the support agent's confirmation queue
      // stops, the warehouse person's stock push with it (one rule for what stops), and nobody but
      // the manager sees the license notice.
      at('2027-04-08T08:00:00Z');
      await check();
      const agent = await modules(support);
      expect(agent.staffNotices).toEqual([
        {
          bundle: 'operations',
          stopsOn: '2027-04-15',
          stopsAt: LAPSED_AT,
          capabilities: ['lapseorders.confirmation_queue'],
        },
      ]);
      expect(agent.licenseNotices).toBeNull();
      expect((await modules(warehouse)).staffNotices).toEqual([
        {
          bundle: 'operations',
          stopsOn: '2027-04-15',
          stopsAt: LAPSED_AT,
          capabilities: ['lapsecarrier.stock_push'],
        },
      ]);
      // External hats see no license, lapse, or commercial notice (W8).
      const buyer = await modules(mediaBuyer);
      expect(buyer.staffNotices).toEqual([]);
      expect(buyer.licenseNotices).toBeNull();
      const partner = await api.call(partnerUser, 'GET', '/api/platform/modules');
      expect(partner.status).toBe(403);
      const me = await api.call(partnerUser, 'GET', '/api/partner/me');
      expect(JSON.stringify(me.body)).not.toMatch(/notice|lapse|license/i);
    });

    it('keeps everything on through grace (AC-18)', async () => {
      expect((await summary()).bundles.find((b) => b.bundle === 'operations')?.phase).toBe('grace');
      for (const capability of [
        'lapseorders.confirmation_queue',
        'lapseorders.write_back',
        'lapsecarrier.new_shipments',
        'lapsecarrier.stock_push',
        'lapsepartner.sales_ingestion',
      ]) {
        expect(await stateOf(capability), capability).toMatchObject({ state: 'on' });
      }
      await eventually(
        async () => ((await schedules(CONFIRMATION_QUEUE.name)).length === 1 ? true : undefined),
        { what: 'the confirmation schedule' },
      );
      expect(await schedules(PUSH_QUEUE.name)).toEqual([LAPSE_SCHEDULES.push]);
      // Only this suite records checks: both license check schedules never fire during the run.
      expect(
        await sql<{ key: string; cron: string }>(
          `SELECT key, cron FROM pgboss.schedule WHERE name = 'platform.license_check' ORDER BY key`,
        ),
      ).toEqual([
        { key: 'daily', cron: NEVER_DURING_A_RUN },
        { key: 'phase-watch', cron: NEVER_DURING_A_RUN },
      ]);

      // Before the lapse: a confirmed first push, and the executing step switched on.
      lapseStore.pushConfirmed = true;
      const step = await api.call(manager, 'PUT', `/api/settings/${LAPSE_STEP}`, {
        value: true,
        reason: 'Write back from now on',
        expectedUpdatedAt: null,
      });
      expect(step.status, JSON.stringify(step.body)).toBe(200);
      expect(await stateOf('lapseorders.write_back')).toMatchObject({ state: 'on' });
      // Nothing waits for a renewal while the step can run.
      expect((await summary()).resumingSteps).toEqual([]);
    });

    it('at the lapse instant stops work without a wind down and keeps pre lapse work limited (AC-18, AC-29)', async () => {
      const sender = api.app.get(JobSender);
      const queued: (string | null)[] = [];
      for (let i = 0; i < 3; i += 1) {
        queued.push(await sender.send(CONFIRMATION_QUEUE, { n: i }, { startAfter: 3_600 }));
      }

      at('2027-04-15T06:00:00Z');
      const result = await check();
      expect(result).toMatchObject({
        operations: 'wind_down',
        warehouse: 'active',
        phaseChanged: true,
      });

      await eventually(
        async () =>
          (await schedules(CONFIRMATION_QUEUE.name)).length === 0 &&
          (await schedules(PUSH_QUEUE.name)).length === 0 &&
          lapseStore.tasks.length === 1
            ? true
            : undefined,
        { what: 'the lapse to stop the confirmation queue and the stock push' },
      );
      for (const id of queued) expect(await jobState(id)).toBe('cancelled');
      // The wind down sweep keeps its schedule.
      expect(await schedules(SWEEP_QUEUE.name)).toEqual([LAPSE_SCHEDULES.sweep]);

      refresh();
      expect(await stateOf('lapseorders.confirmation_queue')).toMatchObject({
        state: 'read_only',
        reason: 'lapsed',
        since: LAPSED_AT,
      });
      expect(await stateOf('lapsecarrier.mirror_reads')).toMatchObject({
        state: 'limited',
        before: LAPSED_AT,
        reason: 'lapsed',
      });
      expect(await stateOf('lapsesettle.reconciliation')).toMatchObject({
        state: 'limited',
        before: LAPSED_AT,
      });
      expect(await stateOf('lapsesettle.close_out')).toMatchObject({
        state: 'limited',
        before: LAPSED_AT,
      });
      expect(await stateOf('lapsepartner.sales_ingestion')).toMatchObject({
        state: 'limited',
        before: LAPSED_AT,
      });
      expect(await stateOf('lapsepartner')).toMatchObject({ state: 'read_only', reason: 'lapsed' });
      // Core never changes (owner ruling 5).
      for (const core of ['lapsecarrier', 'lapsesettle', 'inventory', 'platform']) {
        expect(await stateOf(core), core).toMatchObject({ state: 'on' });
      }

      // The stock push loses its only source: its jobs go, its first push confirmation is cleared
      // (W10), and one manager task opens (AC-29).
      expect(await stateOf('lapsecarrier.stock_push')).toMatchObject({
        state: 'read_only',
        reason: 'no_stock_out_source',
        since: LAPSED_AT,
      });
      expect(lapseStore.disabled).toEqual([
        { capability: 'lapsecarrier.stock_push', reason: 'no_stock_out_source' },
      ]);
      expect(lapseStore.pushConfirmed).toBe(false);
      expect(lapseStore.tasks).toEqual([
        {
          kind: 'stock_out_source_missing',
          key: `lapsecarrier.stock_push:${LAPSED_AT}`,
          capability: 'lapsecarrier.stock_push',
        },
      ]);
      // The step cannot run while its capability is read only.
      expect(
        (await modules()).capabilities.find((c) => c.key === 'lapseorders.write_back'),
      ).toMatchObject({ state: 'read_only' });

      // The reduced daily report carries the notice on every wind down day.
      const notice = (await api.app.get(LicenseService).notice()).find(
        (n) => n.bundle === 'operations',
      );
      expect(notice).toMatchObject({ phase: 'wind_down', level: 'critical', inReport: true });
      // Staff whose work stopped keep their neutral notice through the wind down (AC-17).
      expect((await modules(support)).staffNotices).toEqual([
        {
          bundle: 'operations',
          stopsOn: '2027-04-15',
          stopsAt: LAPSED_AT,
          capabilities: ['lapseorders.confirmation_queue'],
        },
      ]);
      // The switched on step waits for a renewal, and the license section can say so (AC-19).
      expect((await summary()).resumingSteps).toEqual([LAPSE_STEP]);
    });

    it('follows in scope deliveries only, the pickup window included (AC-18, D5)', async () => {
      lapseStore.deliveries.push(
        // Created by the carrier just before the lapse, first seen after it.
        {
          id: 'A',
          carrierCreatedAt: '2027-04-14T21:50:00Z',
          orderConfirmedAt: '2027-04-14T10:00:00Z',
        },
        // The morning after the lapse, for an order confirmed the evening before.
        {
          id: 'B',
          carrierCreatedAt: '2027-04-15T07:00:00Z',
          orderConfirmedAt: '2027-04-14T18:00:00Z',
        },
        // Four days after, for an order confirmed the evening before: past the pickup window.
        {
          id: 'C',
          carrierCreatedAt: '2027-04-19T07:00:00Z',
          orderConfirmedAt: '2027-04-14T18:00:00Z',
        },
        // The morning after, for an order confirmed after the lapse.
        {
          id: 'D',
          carrierCreatedAt: '2027-04-15T08:00:00Z',
          orderConfirmedAt: '2027-04-15T07:00:00Z',
        },
      );
      const service = api.app.get(LicenseService);
      expect(await service.windDownScope()).toEqual({
        cutAt: LAPSED_AT,
        pickupWindowEndsAt: '2027-04-17T22:00:00.000000Z',
      });
      expect(await service.inWindDownScope(lapseStore.deliveries[1]!)).toBe('in_scope');
      expect(await service.inWindDownScope(lapseStore.deliveries[2]!)).toBe('out_of_scope');

      await api.app.get(JobSender).send(SWEEP_QUEUE, {});
      await eventually(() => (lapseStore.swept.length === 1 ? true : undefined), {
        what: 'the wind down sweep',
      });
      expect(lapseStore.swept).toEqual([['A', 'B']]);

      // A carrier webhook during the wind down: one for an in scope delivery is processed, one for
      // a later delivery is answered 200 and recorded ignored_unlicensed.
      const states = api.app.get(ModuleStateService);
      expect(await states.acceptsHook('lapsecarrier.mirror_reads', lapseStore.deliveries[1])).toBe(
        'process',
      );
      expect(await states.acceptsHook('lapsecarrier.mirror_reads', lapseStore.deliveries[2])).toBe(
        'ignored_unlicensed',
      );
      expect(await states.acceptsHook('lapsecarrier.new_shipments', lapseStore.deliveries[0])).toBe(
        'ignored_unlicensed',
      );
    });

    it('lets a pre lapse order reach reconciled and a person account a fee and close the period (AC-18, D1)', async () => {
      lapseStore.orders.push(
        { id: 'O1', openedAt: '2027-04-12T10:00:00Z', cash: 'delivered' },
        { id: 'LATE', openedAt: '2027-04-15T07:00:00Z', cash: 'delivered' },
      );
      lapseStore.periods.push(
        { id: 'P1', openedAt: '2027-04-01T08:00:00Z', fees: 0, closed: false },
        { id: 'P2', openedAt: '2027-04-10T08:00:00Z', fees: 0, closed: false },
        { id: 'PNEW', openedAt: '2027-04-15T07:00:00Z', fees: 0, closed: false },
      );
      for (const cash of ['collected_by_carrier', 'remitted', 'reconciled']) {
        const moved = await api.call(manager, 'POST', '/api/lapse-settle/orders/O1/cash', { cash });
        expect(moved.status, cash).toBe(200);
      }
      const late = await api.call(manager, 'POST', '/api/lapse-settle/orders/LATE/cash', {
        cash: 'remitted',
      });
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ code: 'MODULE_LIMITED', before: LAPSED_AT });
      lapseStore.orders = lapseStore.orders.filter((order) => order.id !== 'LATE');

      expect(
        (await api.call(manager, 'POST', '/api/lapse-settle/periods/P1/fees', {})).status,
      ).toBe(200);
      expect(
        (await api.call(manager, 'POST', '/api/lapse-settle/periods/P1/close', {})).status,
      ).toBe(200);
      const newer = await api.call(manager, 'POST', '/api/lapse-settle/periods/PNEW/close', {});
      expect(newer.status).toBe(409);
      expect(newer.body).toMatchObject({ code: 'MODULE_LIMITED' });
      lapseStore.periods = lapseStore.periods.filter((period) => period.id !== 'PNEW');
    });

    it('accepts a partner statement for days before the lapse and closes the period that started before it (AC-28, W1)', async () => {
      const before = await api.call(manager, 'POST', '/api/lapse-partner/sales-days', {
        partnerId: 'X',
        salesDay: '2027-04-14',
      });
      expect(before.status).toBe(200);
      const after = await api.call(manager, 'POST', '/api/lapse-partner/sales-days', {
        partnerId: 'X',
        salesDay: '2027-04-15',
      });
      expect(after.status).toBe(409);
      expect(after.body).toMatchObject({ code: 'MODULE_LIMITED', before: LAPSED_AT });
      const closed = await api.call(manager, 'POST', '/api/lapse-partner/periods', {
        partnerId: 'X',
        start: '2027-04-01',
        end: '2027-04-14',
        amountOwed: '1500.00',
      });
      expect(closed.status).toBe(200);
      expect(closed.body).toEqual({ amountOwed: '1500.00' });
      const later = await api.call(manager, 'POST', '/api/lapse-partner/periods', {
        partnerId: 'X',
        start: '2027-04-15',
        end: '2027-04-30',
        amountOwed: '10.00',
      });
      expect(later.status).toBe(409);
    });

    it('never ends the wind down early before the pickup window, then ends it once the last order reconciles (AC-15, AC-18)', async () => {
      // Day 0: every known pre lapse order is reconciled, but the pickup window holds the end.
      refresh();
      expect((await check()).operations).toBe('wind_down');
      expect((await api.app.get(LicenseService).windDown())?.phase).toBe('wind_down');

      // A delivery created before the lapse turns up late: one open order again.
      lapseStore.orders.push({ id: 'O2', openedAt: '2027-04-14T20:00:00Z', cash: 'delivered' });
      at('2027-04-18T06:00:00Z');
      expect((await check()).operations).toBe('wind_down');
      expect(windDownEnds).toEqual([]);

      expect(
        (
          await api.call(manager, 'POST', '/api/lapse-settle/orders/O2/cash', {
            cash: 'reconciled',
          })
        ).status,
      ).toBe(200);
      // The api records the end this time (as an upload or an api start would): the worker graph
      // still hears of it, through NOTIFY (code review M3).
      const ended = await api.app.get(LicenseService).checkFile('daily');
      expect(ended.operations).toBe('off');
      await eventually(
        () => (windDownEnds.length === 1 && apiWindDownEnds.length === 1 ? true : undefined),
        { what: 'WindDownEnded in both processes' },
      );
      await worker.get(ModuleJobSupervisor).reconcile();
      refresh();
      expect(windDownEnds[0]?.lapsedAt).toBe(LAPSED_AT);
      expect(apiWindDownEnds[0]).toEqual(windDownEnds[0]);
      expect(lapseStore.tasks.filter((t) => t.kind === 'wind_down_ended')).toEqual([
        {
          kind: 'wind_down_ended',
          key: LAPSED_AT,
          lapsedAt: LAPSED_AT,
          endedAt: windDownEnds[0]?.endedAt,
        },
      ]);
      // The end is recorded once: the next check keeps off, with no second event or task.
      expect((await check()).operations).toBe('off');
      expect(windDownEnds).toHaveLength(1);
      expect(apiWindDownEnds).toHaveLength(1);
      expect(lapseStore.tasks.filter((t) => t.kind === 'wind_down_ended')).toHaveLength(1);
      // Sticky off: more open orders later never bring the wind down back.
      lapseStore.orders.push({ id: 'O3', openedAt: '2027-04-13T20:00:00Z', cash: 'delivered' });
      refresh();
      expect((await summary()).bundles.find((b) => b.bundle === 'operations')?.phase).toBe('off');
      lapseStore.orders = lapseStore.orders.filter((order) => order.id !== 'O3');
    });

    it('after the wind down ends, stops pre lapse work and keeps until closed work limited while it is open (AC-18, AC-28, W1)', async () => {
      await eventually(
        async () => ((await schedules(SWEEP_QUEUE.name)).length === 0 ? true : undefined),
        { what: 'the sweep to stop' },
      );
      refresh();
      expect(await stateOf('lapsecarrier.mirror_reads')).toMatchObject({
        state: 'read_only',
        reason: 'lapsed',
      });
      expect(await stateOf('lapsesettle.reconciliation')).toMatchObject({
        state: 'read_only',
        reason: 'lapsed',
      });
      // Every Operations event after the end is ignored.
      const states = api.app.get(ModuleStateService);
      expect(await states.acceptsHook('lapsecarrier.mirror_reads', lapseStore.deliveries[0])).toBe(
        'ignored_unlicensed',
      );
      // Even an until closed capability still finishing old work ignores every event after the
      // end (AC-18): the close out takes the Bosta file by hand, never a carrier webhook.
      expect(await stateOf('lapsesettle.close_out')).toMatchObject({ state: 'limited' });
      expect(
        await states.acceptsHook('lapsesettle.close_out', { openedAt: '2027-04-10T08:00:00Z' }),
      ).toBe('ignored_unlicensed');
      // The day notice in off: pre lapse work is under what stopped, nothing continues to the
      // wind down's last day, and until closed work still finishes (web review H1, W1).
      const offNotice = (await api.app.get(LicenseService).notice()).find(
        (n) => n.bundle === 'operations',
      );
      expect(offNotice).toMatchObject({ phase: 'off', inReport: false });
      expect(offNotice?.stops).toEqual(
        expect.arrayContaining(['lapsecarrier.mirror_reads', 'lapsesettle.reconciliation']),
      );
      expect(offNotice?.continues.every((c) => c.until === 'open_items_closed')).toBe(true);

      // Carrier close out: P2 is still open, so the close out stays limited until it closes.
      expect(await stateOf('lapsesettle.close_out')).toMatchObject({
        state: 'limited',
        before: LAPSED_AT,
      });
      expect(
        (await api.call(manager, 'POST', '/api/lapse-settle/periods/P2/close', {})).status,
      ).toBe(200);
      refresh();
      expect(await stateOf('lapsesettle.close_out')).toMatchObject({
        state: 'read_only',
        reason: 'lapsed',
      });

      // Partner Y has unreported days before the cut since its latest closed period (2027-03-31)
      // and no next period created: ingestion and its close out stay limited.
      expect(await stateOf('lapsepartner.sales_ingestion')).toMatchObject({
        state: 'limited',
        before: LAPSED_AT,
      });
      expect(await stateOf('lapsepartner.settlement_close_out')).toMatchObject({
        state: 'limited',
        before: LAPSED_AT,
      });
      for (const salesDay of ['2027-04-11', '2027-04-12', '2027-04-13', '2027-04-14']) {
        const recorded = await api.call(manager, 'POST', '/api/lapse-partner/sales-days', {
          partnerId: 'Y',
          salesDay,
        });
        expect(recorded.status, salesDay).toBe(200);
      }
      refresh();
      expect(await stateOf('lapsepartner.sales_ingestion')).toMatchObject({
        state: 'read_only',
        reason: 'lapsed',
      });
      const refused = await api.call(manager, 'POST', '/api/lapse-partner/sales-days', {
        partnerId: 'Y',
        salesDay: '2027-04-14',
      });
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ code: 'MODULE_OFF' });
      for (const core of ['lapsecarrier', 'lapseorders', 'inventory']) {
        expect(await stateOf(core), core).toMatchObject({ state: 'on' });
      }
    });

    it('a renewal backfills the gap once and the step acts on nothing from before it (AC-19, AC-27, W10)', async () => {
      lapseStore.records.push(
        { id: 'R0', eventAt: '2027-04-10T10:00:00Z' },
        { id: 'G1', eventAt: '2027-05-01T10:00:00Z' },
      );
      // A write back of the gap order sent while it is stopped is cancelled, never run.
      const sender = api.app.get(JobSender);
      const gapJob = await sender.send(
        WRITE_BACK_QUEUE,
        { records: ['G1'] },
        { step: LAPSE_STEP, startAfter: 3_600 },
      );
      await worker.get(ModuleJobSupervisor).reconcile();
      expect(await jobState(gapJob)).toBe('cancelled');

      at('2027-05-20T08:00:00Z');
      expect((await summary()).resumingSteps).toEqual([LAPSE_STEP]);
      const install = await installOf(api);
      const renewal = license(
        {
          licenseId: 'SSD-LAPSE-0002',
          bundles: ['operations'],
          operationsExpiresOn: '2028-03-31',
          warehouseExpiresOn: undefined,
          issuedOn: '2027-05-19',
        },
        install,
      );
      const reply = await api.call(manager, 'POST', '/api/platform/license', { envelope: renewal });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const answer = PostLicenseAnswer.parse(reply.body);
      expect(answer.changed).toBe(true);
      expect(answer.resumingSteps).toEqual([LAPSE_STEP]);
      expect(answer.summary.resumingSteps).toEqual([]);
      expect(answer.summary.bundles.find((b) => b.bundle === 'operations')).toMatchObject({
        phase: 'active',
        expiresOn: '2028-03-31',
      });
      const renewedAt = '2027-05-20T08:00:00.000000Z';

      // The worker hears of it through NOTIFY: schedules back, one backfill for the gap.
      await eventually(
        async () =>
          lapseStore.backfills.length === 1 &&
          (await schedules(CONFIRMATION_QUEUE.name)).length === 1
            ? true
            : undefined,
        { what: 'the renewal backfill and the restored schedule' },
      );
      expect(lapseStore.backfills).toEqual([
        {
          capability: 'lapsecarrier.new_shipments',
          from: LAPSED_AT,
          to: renewedAt,
          cause: 'renewed',
        },
      ]);
      await worker.get(ModuleJobSupervisor).reconcile();
      expect(await sql(`SELECT id FROM pgboss.job WHERE name = 'platform.backfill'`)).toHaveLength(
        1,
      );

      refresh();
      expect(await stateOf('lapseorders.write_back')).toMatchObject({
        state: 'on',
        since: renewedAt,
      });
      expect(
        (await modules()).capabilities.find((c) => c.key === 'lapseorders.write_back')?.since,
      ).toBe(renewedAt);

      // The step acts only on events from the renewal on: not on last week's order, not on the gap.
      lapseStore.records.push({ id: 'N1', eventAt: '2027-05-20T09:00:00Z' });
      const now = await sender.send(
        WRITE_BACK_QUEUE,
        { records: ['R0', 'G1', 'N1'] },
        { step: LAPSE_STEP },
      );
      await eventually(async () => ((await jobState(now)) === 'completed' ? true : undefined), {
        what: 'the write back job',
      });
      expect(lapseStore.commands).toEqual([{ recordId: 'N1', step: LAPSE_STEP }]);
      const queuedGap = await sql(
        `SELECT id FROM pgboss.job WHERE name = $1 AND state < 'active' AND data -> 'records' ? 'G1'`,
        [WRITE_BACK_QUEUE.name],
      );
      expect(queuedGap).toEqual([]);

      // The stock push runs again with its source back, but waits for a new confirmed preview (W10).
      await eventually(
        async () => ((await schedules(PUSH_QUEUE.name)).length === 1 ? true : undefined),
        { what: 'the push schedule' },
      );
      const push = await sender.send(PUSH_QUEUE, {});
      await eventually(async () => ((await jobState(push)) === 'completed' ? true : undefined), {
        what: 'the push job',
      });
      expect(lapseStore.pushes.at(-1)).toEqual({ waiting: 'NEW_PREVIEW' });
    });

    it('a Warehouse pilot license goes grace then off with a dispatched transfer still receivable (AC-18, AC-28)', async () => {
      at('2027-10-05T08:00:00Z');
      expect(await check()).toMatchObject({ warehouse: 'grace', operations: 'active' });
      expect(await stateOf('lapsestock.transfers')).toMatchObject({ state: 'on' });
      lapseStore.pushConfirmed = true;

      // Seven days before the Warehouse lapse, the warehouse person whose work stops is told.
      at('2027-10-08T08:00:00Z');
      const told = await modules(warehouse);
      expect(told.staffNotices).toEqual([
        expect.objectContaining({
          bundle: 'warehouse',
          stopsOn: '2027-10-15',
          capabilities: ['lapsecarrier.stock_push', 'lapsestock.transfers'],
        }),
      ]);

      lapseStore.transfers.push(
        { id: 'T1', dispatchedAt: '2027-10-12T09:00:00Z', received: false },
        { id: 'T2', dispatchedAt: '2027-10-15T09:00:00Z', received: false },
      );
      at('2027-10-15T06:00:00Z');
      expect(await check()).toMatchObject({
        warehouse: 'off',
        operations: 'active',
      });
      const lapsedAt = (await summary()).bundles.find((b) => b.bundle === 'warehouse')?.lapsesAt;
      expect(lapsedAt).toBeTruthy();
      expect(await stateOf('lapsestock')).toMatchObject({ state: 'read_only', reason: 'lapsed' });
      expect(await stateOf('lapsestock.transfers')).toMatchObject({
        state: 'read_only',
        reason: 'lapsed',
      });
      expect(await stateOf('lapsestock.transfers_receive')).toMatchObject({
        state: 'limited',
        before: lapsedAt,
      });
      // The stock push pauses with the Warehouse plan (AC-29), and Operations work keeps running.
      expect(await stateOf('lapsecarrier.stock_push')).toMatchObject({
        state: 'read_only',
        reason: 'lapsed',
      });
      expect(await stateOf('lapseorders.confirmation_queue')).toMatchObject({ state: 'on' });
      await eventually(
        async () => ((await schedules(PUSH_QUEUE.name)).length === 0 ? true : undefined),
        { what: 'the push to stop' },
      );

      expect(
        (await api.call(warehouse, 'POST', '/api/lapse-stock/transfers/T1/receive', {})).status,
      ).toBe(200);
      const newer = await api.call(warehouse, 'POST', '/api/lapse-stock/transfers/T2/receive', {});
      expect(newer.status).toBe(409);
      expect(newer.body).toMatchObject({ code: 'MODULE_LIMITED', before: lapsedAt });
      lapseStore.transfers = lapseStore.transfers.filter((t) => t.id !== 'T2');
      refresh();
      expect(await stateOf('lapsestock.transfers_receive')).toMatchObject({
        state: 'read_only',
        reason: 'lapsed',
      });

      expect(errorLines.filter((line) => QUIET.has(line.context))).toEqual([]);
    });
  },
);
