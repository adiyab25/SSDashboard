import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  ModuleStatesResponse,
  OffImpact,
  SettingsListResponse,
  type LicenseBundle,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JobRegistry } from '../src/platform/jobs/job-registry.js';
import { JobSender } from '../src/platform/jobs/job-sender.js';
import { ModuleJobSupervisor } from '../src/platform/jobs/module-job-supervisor.js';
import { LICENSE_KEY_SET, LICENSE_KEYS } from '../src/platform/license/license-keys.js';
import { signLicense } from '../src/platform/license/license-signing.js';
import { CapabilityHooks } from '../src/platform/modules/capability-hooks.js';
import { MODULE_ROWS } from '../src/platform/modules/module-registry.js';
import { ModuleStateService } from '../src/platform/modules/module-state.service.js';
import { routeDeclarationOf } from '../src/platform/modules/requires-module.decorator.js';
import { WorkerModule } from '../src/worker.module.js';
import {
  FIXTURE_MODULE_ROWS,
  FIXTURE_QUEUE,
  FIXTURE_SCHEDULE_KEY,
  FixtureOperationsModule,
  FixtureOperationsWorkerModule,
  fixtureStore,
  SHARED_CORE_KEY,
  SHARED_QUEUE,
} from './fixtures/fixture-operations.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { testVendorKey, trustTestKey, type TestVendorKey } from './license-support.js';
import { routeCatalog } from './route-catalog.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0009 milestone 3 (AC-6, AC-8, AC-10, AC-11, AC-12, AC-28, AC-30): a fixture Operations
// module turns off with no orphaned jobs, turns back on restoring its schedules and replaying
// nothing, lists what drops before it goes, lets work in flight finish, and a capability on a
// shared queue stops while the queue keeps working.

// Load the root .env into this process's env before any api saves it: the file starts two apps
// in turn, and the first one's close restores the env it found.
devDatabaseUrl();

const TOGGLE = 'module.fixtureops.enabled';
/** Logger contexts whose error lines AC-10 forbids: the supervisor, the gate, the job handlers. */
const QUIET = new Set([
  'ModuleJobs',
  'ModuleState',
  'Jobs',
  'LedgerReconcile',
  'AuthCleanup',
  'Mail',
]);

/** Every error line written while the suite runs, with its logger context. */
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

/**
 * Writes a license file for the scratch install, signed with the suite's vendor key, before the
 * api starts, so the api start check records it (code review m3, finding 9).
 */
async function writeLicense(
  owner: DatabaseConnection,
  key: TestVendorKey,
  file: string,
  bundles: LicenseBundle[],
): Promise<void> {
  const { rows } = await owner.pool.query<{ id: string; client_code: string }>(
    'SELECT id::text AS id, client_code FROM install',
  );
  const install = { tenantId: rows[0]?.id as string, clientCode: rows[0]?.client_code as string };
  writeFileSync(
    file,
    signLicense(
      {
        format: 1,
        licenseId: `SSD-FIXTURE-${bundles.join('-')}`,
        clientCode: install.clientCode,
        tenantId: install.tenantId,
        bundles,
        ...(bundles.includes('operations') && { operationsExpiresOn: '2099-11-07' }),
        issuedOn: '2026-11-07',
      },
      key.entry.keyId,
      key.privateKey,
    ),
  );
}

/** The worker entry point's graph with the fixture, on the api's database. */
async function startWorker(key: TestVendorKey): Promise<TestingModule> {
  const worker = await Test.createTestingModule({
    imports: [WorkerModule, FixtureOperationsWorkerModule],
  })
    .overrideProvider(MODULE_ROWS)
    .useValue(FIXTURE_MODULE_ROWS)
    .overrideProvider(LICENSE_KEY_SET)
    .useValue([...LICENSE_KEYS, key.entry])
    .compile();
  worker.useLogger(captureLogger);
  await worker.init();
  return worker;
}

/** Starts the api with the fixture and a license of `bundles` in the file it reads at start. */
async function startApi(
  key: TestVendorKey,
  file: string,
  bundles: LicenseBundle[],
): Promise<InProcessApi> {
  const api = await startInProcessApi(
    (builder) => {
      trustTestKey(builder, key);
      builder.overrideProvider(MODULE_ROWS).useValue(FIXTURE_MODULE_ROWS);
    },
    {
      licenseFile: file,
      imports: [FixtureOperationsModule],
      prepare: (owner) => writeLicense(owner, key, file, bundles),
    },
  );
  api.app.useLogger(captureLogger);
  return api;
}

/** Queries the api's scratch database as its owner. */
function sqlOf(api: InProcessApi) {
  return async <T extends object>(text: string, values: unknown[] = []): Promise<T[]> =>
    (await api.owner.pool.query<T>(text, values)).rows;
}

describe(
  'a fixture Operations module and its jobs (spec 0009 milestone 3)',
  { timeout: 180_000 },
  () => {
    const key = testVendorKey();
    const dir = mkdtempSync(join(tmpdir(), 'ssd-modules-'));
    const file = join(dir, 'license.json');
    let api: InProcessApi;
    let worker: TestingModule;
    let manager: string;
    let costManager: string;
    let mediaBuyer: string;
    let sql: ReturnType<typeof sqlOf>;
    /** The three queued jobs the turn off cancelled, checked again after the turn on. */
    const cancelledJobs: (string | null)[] = [];

    const schedules = (queue: string) =>
      sql<{ key: string; timezone: string }>(
        `SELECT key, timezone FROM pgboss.schedule WHERE name = $1 ORDER BY key`,
        [queue],
      );
    /** The state of each job by id, in the order given. */
    const statesOf = async (ids: readonly (string | null)[]) => {
      const rows = await sql<{ id: string; state: string }>(
        `SELECT id::text AS id, state::text AS state FROM pgboss.job WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return ids.map((id) => rows.find((row) => row.id === id)?.state);
    };
    const jobStates = async (queue: string) =>
      Object.fromEntries(
        (
          await sql<{ state: string; n: number }>(
            `SELECT state::text AS state, count(*)::int AS n FROM pgboss.job WHERE name = $1 GROUP BY state`,
            [queue],
          )
        ).map((row) => [row.state, row.n]),
      ) as Record<string, number>;
    const entry = async (settingKey: string) => {
      const reply = await api.call(manager, 'GET', '/api/settings');
      const found = SettingsListResponse.parse(reply.body).entries.find(
        (e) => e.key === settingKey,
      );
      if (!found) throw new Error(`no entry ${settingKey}`);
      return found;
    };
    const toggle = async (value: boolean) => {
      const current = await entry(TOGGLE);
      return api.call(manager, 'PUT', `/api/settings/${TOGGLE}`, {
        value,
        reason: value ? 'Back on for the test' : 'Off for the test',
        expectedUpdatedAt: current.updatedAt,
      });
    };
    const modules = async () =>
      ModuleStatesResponse.parse((await api.call(manager, 'GET', '/api/platform/modules')).body);
    const stateOf = async (key: string) => {
      const all = await modules();
      return [...all.modules, ...all.capabilities].find((view) => view.key === key);
    };

    beforeAll(async () => {
      fixtureStore.reset();
      errorLines.length = 0;
      api = await startApi(key, file, ['warehouse', 'operations']);
      sql = sqlOf(api);
      worker = await startWorker(key);
      const person = await api.addPerson(['manager'], { costView: false });
      manager = await api.signIn(person.email);
      const costPerson = await api.addPerson(['manager'], { costView: true });
      costManager = await api.signIn(costPerson.email);
      const buyer = await api.addPerson(['media_buyer']);
      mediaBuyer = await api.signIn(buyer.email);
    });

    afterAll(async () => {
      await worker?.close();
      await api?.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('starts with the fixture module on, its schedule registered, and its toggle listed', async () => {
      // The license file was in place before the api started: its start check recorded it.
      const checks = await sql<{ trigger: string; outcome: string }>(
        `SELECT trigger::text AS trigger, outcome::text AS outcome FROM license_checks ORDER BY seq`,
      );
      expect(checks[0]).toEqual({ trigger: 'api_start', outcome: 'valid' });
      expect(await stateOf('fixtureops')).toMatchObject({ state: 'on' });
      expect(await entry(TOGGLE)).toMatchObject({
        group: 'modules',
        bundle: 'operations',
        value: true,
        reason: 'required',
        licensed: true,
      });
      await eventually(
        async () => ((await schedules(FIXTURE_QUEUE.name)).length === 1 ? true : undefined),
        { what: 'the fixture schedule' },
      );
      expect(await schedules(FIXTURE_QUEUE.name)).toEqual([
        { key: FIXTURE_SCHEDULE_KEY, timezone: 'Africa/Cairo' },
      ]);
    });

    it('refuses a toggle of a core module (404 SETTING_UNKNOWN)', async () => {
      const reply = await api.call(manager, 'PUT', '/api/settings/module.platform.enabled', {
        value: false,
        reason: 'x',
        expectedUpdatedAt: null,
      });
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ code: 'SETTING_UNKNOWN' });
    });

    it('refuses to turn off a module another on module requires (AC-12, MODULE_REQUIRED_BY)', async () => {
      const refused = await toggle(false);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'MODULE_REQUIRED_BY',
        dependants: ['fixturedependant'],
      });
      expect((await entry(TOGGLE)).value).toBe(true);
      const dependant = await api.call(
        manager,
        'PUT',
        '/api/settings/module.fixturedependant.enabled',
        {
          value: false,
          reason: 'Not used here',
          expectedUpdatedAt: null,
        },
      );
      expect(dependant.status).toBe(200);
      expect(await stateOf('fixturedependant')).toMatchObject({
        state: 'read_only',
        reason: 'toggled_off',
      });
      // A write of the value in force changes nothing and runs no module rule (code review m3, 13).
      const unchanged = await api.call(manager, 'PUT', `/api/settings/${TOGGLE}`, {
        value: true,
        reason: 'Already on',
        expectedUpdatedAt: null,
      });
      expect(unchanged.status).toBe(200);
      expect(unchanged.body).toMatchObject({ changed: false, entry: { value: true } });
    });

    it('a module turns off with no orphaned jobs (AC-10)', async () => {
      const sender = api.app.get(JobSender);
      const queued: (string | null)[] = [];
      for (let i = 0; i < 3; i += 1) {
        queued.push(await sender.send(FIXTURE_QUEUE, { n: i }, { startAfter: 3_600 }));
      }
      fixtureStore.commands.push({
        id: 'c1',
        capability: 'fixtureops.queue',
        kind: 'fixture.push',
        state: 'waiting',
        reason: null,
      });
      expect(await statesOf(queued)).toEqual(['created', 'created', 'created']);

      const reply = await toggle(false);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ changed: true, entry: { value: false } });

      await eventually(
        async () =>
          (await schedules(FIXTURE_QUEUE.name)).length === 0 &&
          !(await jobStates(FIXTURE_QUEUE.name)).created &&
          fixtureStore.disabled.length === 1
            ? true
            : undefined,
        { what: 'the fixture module to stop' },
      );
      expect(await statesOf(queued)).toEqual(['cancelled', 'cancelled', 'cancelled']);
      const states = await jobStates(FIXTURE_QUEUE.name);
      expect(states.active ?? 0).toBe(0);
      expect(states.failed ?? 0).toBe(0);
      expect(fixtureStore.commands[0]).toMatchObject({ state: 'failed', reason: 'MODULE_OFF' });
      expect(fixtureStore.disabled).toEqual([
        { capability: 'fixtureops.queue', state: 'read_only', reason: 'toggled_off' },
      ]);

      // Routes: reads answer, new work is 404 MODULE_OFF, an anonymous caller still gets 401.
      expect(await stateOf('fixtureops')).toMatchObject({
        state: 'read_only',
        reason: 'toggled_off',
      });
      expect((await api.call(manager, 'GET', '/api/fixture-operations')).status).toBe(200);
      const write = await api.call(manager, 'POST', '/api/fixture-operations/records', {});
      expect(write.status).toBe(404);
      expect(write.body).toMatchObject({ code: 'MODULE_OFF' });
      expect(
        (await api.call(undefined, 'POST', '/api/fixture-operations/records', {})).status,
      ).toBe(401);
      // A caller with no internal hat learns what runs, never when or why it stopped (W8).
      const external = ModuleStatesResponse.parse(
        (await api.call(mediaBuyer, 'GET', '/api/platform/modules')).body,
      );
      expect(external.modules.find((view) => view.key === 'fixtureops')).toEqual({
        key: 'fixtureops',
        state: 'read_only',
        since: null,
        before: null,
        reason: null,
      });
      expect(
        [...external.modules, ...external.capabilities].every(
          (view) => view.since === null && view.before === null && view.reason === null,
        ),
      ).toBe(true);
      expect(external.licenseNotices).toBeNull();
      expect(errorLines.filter((line) => QUIET.has(line.context))).toEqual([]);
      cancelledJobs.push(...queued);
    });

    it('turning it back on restores schedules and replays nothing (AC-11)', async () => {
      // A time zone change while off: the restored schedule takes the zone in force (R11).
      const zone = await entry('timezone');
      const moved = await api.call(manager, 'PUT', '/api/settings/timezone', {
        value: 'Asia/Dubai',
        reason: 'Moved for the test',
        expectedUpdatedAt: zone.updatedAt,
      });
      expect(moved.status).toBe(200);
      const offAt = (await entry(TOGGLE)).updatedAt;

      const reply = await toggle(true);
      expect(reply.status).toBe(200);
      const onAt = (await entry(TOGGLE)).updatedAt;

      await eventually(
        async () => ((await schedules(FIXTURE_QUEUE.name)).length === 1 ? true : undefined),
        { what: 'the fixture schedule to return' },
      );
      expect(await schedules(FIXTURE_QUEUE.name)).toEqual([
        { key: FIXTURE_SCHEDULE_KEY, timezone: 'Asia/Dubai' },
      ]);
      await eventually(() => (fixtureStore.backfills.length === 1 ? true : undefined), {
        what: 'the backfill',
      });
      expect(fixtureStore.backfills).toEqual([
        { capability: 'fixtureops.queue', from: offAt, to: onAt, cause: 'module_resumed' },
      ]);

      // A second reconcile adds no backfill; nothing cancelled comes back; the command stays failed.
      await worker.get(ModuleJobSupervisor).reconcile({ key: TOGGLE, from: offAt!, to: onAt! });
      expect(await jobStates('platform.backfill')).toEqual({ completed: 1 });
      expect(await statesOf(cancelledJobs)).toEqual(['cancelled', 'cancelled', 'cancelled']);
      expect(fixtureStore.commands[0]).toMatchObject({ state: 'failed', reason: 'MODULE_OFF' });

      // Work runs again.
      const id = await api.app.get(JobSender).send(FIXTURE_QUEUE, {});
      await eventually(
        () => (fixtureStore.handled.some((job) => job.id === id) ? true : undefined),
        { what: 'a new fixture job to be worked' },
      );
      expect((await api.call(manager, 'POST', '/api/fixture-operations/records', {})).status).toBe(
        200,
      );
      expect(errorLines.filter((line) => QUIET.has(line.context))).toEqual([]);
    });

    it('the off dialog lists what drops and in flight work finishes (AC-28, AC-30)', async () => {
      fixtureStore.commands.push(
        {
          id: 'c2',
          capability: 'fixtureops.queue',
          kind: 'fixture.push',
          state: 'waiting',
          reason: null,
        },
        {
          id: 'c3',
          capability: 'fixtureops.queue',
          kind: 'fixture.push',
          state: 'waiting',
          reason: null,
        },
        {
          id: 'c4',
          capability: 'fixtureops.queue',
          kind: 'fixture.cancel',
          state: 'waiting',
          reason: null,
        },
      );
      fixtureStore.openFinish = 1;
      // Unreported sales days before the cut, and no batch imported (W1, re-check R1).
      fixtureStore.openSalesDays = 1;
      fixtureStore.inFlight = [{ area: 'fixture_returns', count: 1 }];
      fixtureStore.partnerStock = [
        {
          partnerId: '0190c0de-0000-7000-8000-00000000f001',
          partnerName: 'Fixture Showroom',
          pieces: 4,
          totalValue: '120.00',
          lastConfirmedSalesDay: '2026-11-01',
        },
      ];

      const impact = await api.call(manager, 'GET', `/api/settings/${TOGGLE}/off-impact`);
      expect(impact.status).toBe(200);
      expect(OffImpact.parse(impact.body)).toEqual({
        waitingCommands: [
          { kind: 'fixture.push', count: 2 },
          { kind: 'fixture.cancel', count: 1 },
        ],
        inFlight: [{ area: 'fixture_returns', count: 1 }],
        partnerStock: [
          {
            partnerId: '0190c0de-0000-7000-8000-00000000f001',
            partnerName: 'Fixture Showroom',
            pieces: 4,
            lastConfirmedSalesDay: '2026-11-01',
          },
        ],
        typedConfirmation: true,
      });
      const withCost = await api.call(costManager, 'GET', `/api/settings/${TOGGLE}/off-impact`);
      expect(OffImpact.parse(withCost.body).partnerStock[0]?.totalValue).toBe('120.00');
      const notAToggle = await api.call(manager, 'GET', '/api/settings/timezone/off-impact');
      expect(notAToggle.status).toBe(404);
      expect(notAToggle.body).toMatchObject({ code: 'SETTING_UNKNOWN' });

      // A job in flight when the module turns off finishes, never failed or cancelled.
      const slow = await api.app.get(JobSender).send(FIXTURE_QUEUE, { slowMs: 4_000 });
      await eventually(
        async () =>
          (
            await sql<{ state: string }>(
              `SELECT state::text AS state FROM pgboss.job WHERE id = $1`,
              [slow],
            )
          )[0]?.state === 'active'
            ? true
            : undefined,
        { what: 'the slow job to start' },
      );
      // "Before the toggle off" by the database clock, the clock that stamps the toggle's
      // `updated_at`, so no skew between Node and PostgreSQL can flip the case.
      const before = (
        await sql<{ at: string }>(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
        )
      )[0]?.at as string;
      expect((await toggle(false)).status).toBe(200);
      const offAt = (await entry(TOGGLE)).updatedAt as string;
      await eventually(
        () => (fixtureStore.handled.some((job) => job.id === slow) ? true : undefined),
        {
          what: 'the slow job to finish',
          timeoutMs: 30_000,
        },
      );
      const finished = await eventually(
        async () => {
          const row = (
            await sql<{ state: string }>(
              `SELECT state::text AS state FROM pgboss.job WHERE id = $1`,
              [slow],
            )
          )[0];
          return row?.state === 'active' ? undefined : row?.state;
        },
        { what: 'the slow job to settle' },
      );
      expect(finished).toBe('completed');

      // The module itself is read only, never limited, so a module level write route with no
      // assertOn of its own is refused by the gate (code review m3, finding 1).
      expect(await stateOf('fixtureops')).toMatchObject({
        state: 'read_only',
        reason: 'toggled_off',
      });
      const plain = await api.call(manager, 'POST', '/api/fixture-operations/records', {});
      expect(plain.status).toBe(404);
      expect(plain.body).toMatchObject({ code: 'MODULE_OFF' });
      // Turning on a module whose required module is off is refused (MODULE_REQUIRES).
      const dependant = await entry('module.fixturedependant.enabled');
      const requires = await api.call(
        manager,
        'PUT',
        '/api/settings/module.fixturedependant.enabled',
        { value: true, reason: 'Needs its base', expectedUpdatedAt: dependant.updatedAt },
      );
      expect(requires.status).toBe(409);
      expect(requires.body).toMatchObject({ code: 'MODULE_REQUIRES', requires: ['fixtureops'] });

      // Limited work: records opened before the toggle off finish; newer ones are refused.
      expect(await stateOf('fixtureops.finish')).toMatchObject({
        state: 'limited',
        before: offAt,
        reason: 'toggled_off',
      });
      expect(await stateOf('fixtureops.queue')).toMatchObject({
        state: 'read_only',
        reason: 'toggled_off',
      });
      const older = await api.call(manager, 'POST', '/api/fixture-operations/finish', {
        openedAt: before,
      });
      expect(older.status).toBe(200);
      const newer = await api.call(manager, 'POST', '/api/fixture-operations/finish', {
        openedAt: new Date(Date.parse(offAt) + 60_000).toISOString(),
      });
      expect(newer.status).toBe(409);
      expect(newer.body).toMatchObject({ code: 'MODULE_LIMITED', before: offAt });
      // Scoped by the business day, never by when it is recorded (W1).
      const yesterday = new Date(Date.parse(offAt) - 86_400_000).toISOString().slice(0, 10);
      const tomorrow = new Date(Date.parse(offAt) + 86_400_000).toISOString().slice(0, 10);
      expect(
        (
          await api.call(manager, 'POST', '/api/fixture-operations/sales-days', {
            salesDay: yesterday,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api.call(manager, 'POST', '/api/fixture-operations/sales-days', {
            salesDay: tomorrow,
          })
        ).status,
      ).toBe(409);
      expect(errorLines.filter((line) => QUIET.has(line.context))).toEqual([]);
    });

    it('keeps a business date capability limited while its days are open, then read only (AC-28, W1)', async () => {
      // Right after the toggle off, with no batch imported, the business date capability stays
      // limited because its open items count the unreported days (re-check R1, S1).
      const offAt = (await entry(TOGGLE)).updatedAt as string;
      expect(await entry(TOGGLE)).toMatchObject({ value: false });
      expect(await stateOf('fixtureops.sales_days')).toMatchObject({
        state: 'limited',
        before: offAt,
        reason: 'toggled_off',
      });

      // The days are reported, or marked settled outside the app (feature 42's count reaches
      // zero): the capability goes read only and the gate refuses new work with 404 MODULE_OFF,
      // while its read keeps answering. The other finishing capability, still open, stays limited.
      fixtureStore.openSalesDays = 0;
      api.app.get(ModuleStateService).licenseChanged();
      expect(await stateOf('fixtureops.sales_days')).toMatchObject({
        state: 'read_only',
        reason: 'toggled_off',
        since: offAt,
      });
      const yesterday = new Date(Date.parse(offAt) - 86_400_000).toISOString().slice(0, 10);
      const refused = await api.call(manager, 'POST', '/api/fixture-operations/sales-days', {
        salesDay: yesterday,
      });
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ code: 'MODULE_OFF' });
      expect((await api.call(manager, 'GET', '/api/fixture-operations')).status).toBe(200);
      expect(await stateOf('fixtureops.finish')).toMatchObject({ state: 'limited' });
      expect(errorLines.filter((line) => QUIET.has(line.context))).toEqual([]);
    });

    it('every registered capability is used (AC-6)', () => {
      const declared = new Set<string>();
      for (const route of [...routeCatalog(AppModule), ...routeCatalog(FixtureOperationsModule)]) {
        const declaration = routeDeclarationOf(route.handler, route.controller);
        if (declaration?.kind === 'capability') declared.add(declaration.key);
      }
      for (const key of worker.get(JobRegistry).declaredCapabilities()) declared.add(key);
      for (const key of worker.get(CapabilityHooks).registered()) declared.add(key);
      for (const key of api.app.get(CapabilityHooks).registered()) declared.add(key);
      const capabilities = FIXTURE_MODULE_ROWS.flatMap((m) => m.capabilities.map((c) => c.key));
      expect(capabilities.filter((key) => !declared.has(key))).toEqual([]);
    });
  },
);

describe(
  'a capability on a shared queue stops while the queue keeps working (AC-10)',
  { timeout: 180_000 },
  () => {
    const key = testVendorKey();
    const dir = mkdtempSync(join(tmpdir(), 'ssd-shared-'));
    const file = join(dir, 'license.json');
    let api: InProcessApi;
    let worker: TestingModule;

    beforeAll(async () => {
      fixtureStore.reset();
      // Operations only: the Warehouse capability on the shared queue is not licensed.
      api = await startApi(key, file, ['operations']);
      worker = await startWorker(key);
    });

    afterAll(async () => {
      await worker?.close();
      await api?.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('refuses a toggle of a module whose plan is not licensed (AC-12, NOT_LICENSED)', async () => {
      const person = await api.addPerson(['manager']);
      const cookie = await api.signIn(person.email);
      const reply = await api.call(cookie, 'PUT', '/api/settings/module.fixturewarehouse.enabled', {
        value: false,
        reason: 'Not licensed here',
        expectedUpdatedAt: null,
      });
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ code: 'NOT_LICENSED' });
      const states = ModuleStatesResponse.parse(
        (await api.call(cookie, 'GET', '/api/platform/modules')).body,
      );
      expect(states.modules.find((m) => m.key === 'fixturewarehouse')).toMatchObject({
        state: 'off',
        reason: 'not_licensed',
      });
      expect(states.capabilities.find((c) => c.key === 'fixturecore.push')).toMatchObject({
        state: 'off',
        reason: 'not_licensed',
      });
    });

    it('keeps only the core schedule and jobs, and works the core jobs', async () => {
      const sql = sqlOf(api);
      const sender = api.app.get(JobSender);
      const laterCore = await sender.send(SHARED_QUEUE, {}, { startAfter: 3_600 });
      const push = await sender.send(
        SHARED_QUEUE,
        {},
        { capability: 'fixturecore.push', startAfter: 3_600 },
      );
      const nowCore = await sender.send(SHARED_QUEUE, {});

      await worker.get(ModuleJobSupervisor).reconcile();

      const keys = await sql<{ key: string }>(
        `SELECT key FROM pgboss.schedule WHERE name = $1 ORDER BY key`,
        [SHARED_QUEUE.name],
      );
      expect(keys.map((row) => row.key)).toEqual([SHARED_CORE_KEY]);

      const queuedPush = await sql(
        `SELECT id FROM pgboss.job WHERE name = $1 AND state < 'active' AND data @> $2::jsonb`,
        [SHARED_QUEUE.name, JSON.stringify({ capability: 'fixturecore.push' })],
      );
      expect(queuedPush).toEqual([]);
      const state = async (id: string | null) =>
        (
          await sql<{ state: string }>(
            `SELECT state::text AS state FROM pgboss.job WHERE id = $1`,
            [id],
          )
        )[0]?.state;
      expect(await state(push)).toBe('cancelled');
      expect(await state(laterCore)).toBe('created');
      await eventually(async () => ((await state(nowCore)) === 'completed' ? true : undefined), {
        what: 'the core job to be worked',
      });
      // By id: the core schedule may add a job of its own, never a push one.
      expect(fixtureStore.handled.find((job) => job.id === nowCore)?.capability).toBe(
        'fixturecore.sync',
      );
      expect(fixtureStore.handled.some((job) => job.capability === 'fixturecore.push')).toBe(false);
    });
  },
);
