import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { SettingsListResponse, type SettingEntryView } from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobSender } from '../src/platform/jobs/job-sender.js';
import { LICENSE_KEY_SET, LICENSE_KEYS } from '../src/platform/license/license-keys.js';
import { signLicense } from '../src/platform/license/license-signing.js';
import { MODULE_ROWS, STEP_SETTING_ROWS } from '../src/platform/modules/module-registry.js';
import { ModuleStateService } from '../src/platform/modules/module-state.service.js';
import { WorkerModule } from '../src/worker.module.js';
import {
  PUSH_READY,
  PUSH_STEP,
  SEND_QUEUE,
  SEND_READY,
  SEND_STEP,
  STEP_MODULE_ROWS,
  STOCK_STEP,
  STEP_SETTINGS,
  StepFixtureModule,
  StepFixtureWorkerModule,
  stepStore,
} from './fixtures/fixture-steps.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { testVendorKey, trustTestKey, type TestVendorKey } from './license-support.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0009 milestone 5, task 24 (AC-21, AC-27, AC-29): executing steps. A fresh install has
// every step off and a job of an off step completes skipped; turning a step on checks its
// preconditions in order (the platform's NO_STOCK_OUT_SOURCE before a failing feature
// precondition) and answers 409 STEP_PRECONDITION with the first failing code; a passing
// precondition's facts reach the settings answer; a step switched on today acts on nothing from
// yesterday; turning it off cancels its queued executions and fails its waiting commands with
// STEP_OFF.

// Load the root .env before any api saves it: the first app's close restores the env it found.
devDatabaseUrl();

/** Writes an Operations only license for the scratch install before the api starts. */
async function writeLicense(owner: DatabaseConnection, key: TestVendorKey, file: string) {
  const { rows } = await owner.pool.query<{ id: string; client_code: string }>(
    'SELECT id::text AS id, client_code FROM install',
  );
  writeFileSync(
    file,
    signLicense(
      {
        format: 1,
        licenseId: 'SSD-FIXTURE-STEPS',
        clientCode: rows[0]?.client_code as string,
        tenantId: rows[0]?.id as string,
        bundles: ['operations'],
        operationsExpiresOn: '2099-11-07',
        issuedOn: '2026-11-07',
      },
      key.entry.keyId,
      key.privateKey,
    ),
  );
}

describe('executing steps (spec 0009 task 24)', { timeout: 180_000 }, () => {
  const key = testVendorKey();
  const dir = mkdtempSync(join(tmpdir(), 'ssd-steps-'));
  const file = join(dir, 'license.json');
  let api: InProcessApi;
  let worker: TestingModule;
  let manager: string;

  const entry = async (settingKey: string): Promise<SettingEntryView> => {
    const reply = await api.call(manager, 'GET', '/api/settings');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const found = SettingsListResponse.parse(reply.body).entries.find((e) => e.key === settingKey);
    if (!found) throw new Error(`no entry ${settingKey}`);
    return found;
  };
  const turn = async (settingKey: string, value: boolean) =>
    api.call(manager, 'PUT', `/api/settings/${settingKey}`, {
      value,
      reason: value ? 'Start it for the test' : 'Stop it for the test',
      expectedUpdatedAt: (await entry(settingKey)).updatedAt,
    });
  const jobOf = async (id: string | null) =>
    (
      await api.owner.pool.query<{ state: string; output: unknown }>(
        'SELECT state::text AS state, output FROM pgboss.job WHERE id = $1',
        [id],
      )
    ).rows[0];
  const audited = async (settingKey: string) =>
    (
      await api.owner.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_entries
         WHERE action = 'setting.changed' AND record_label = $1`,
        [settingKey],
      )
    ).rows[0]?.n;
  const workerStates = () => worker.get(ModuleStateService);

  beforeAll(async () => {
    stepStore.reset();
    api = await startInProcessApi(
      (builder) => {
        trustTestKey(builder, key);
        builder.overrideProvider(MODULE_ROWS).useValue(STEP_MODULE_ROWS);
        builder.overrideProvider(STEP_SETTING_ROWS).useValue(STEP_SETTINGS);
      },
      {
        licenseFile: file,
        imports: [StepFixtureModule],
        prepare: (owner) => writeLicense(owner, key, file),
      },
    );
    worker = await Test.createTestingModule({ imports: [WorkerModule, StepFixtureWorkerModule] })
      .overrideProvider(MODULE_ROWS)
      .useValue(STEP_MODULE_ROWS)
      .overrideProvider(STEP_SETTING_ROWS)
      .useValue(STEP_SETTINGS)
      .overrideProvider(LICENSE_KEY_SET)
      .useValue([...LICENSE_KEYS, key.entry])
      .compile();
    worker.useLogger(false);
    await worker.init();
    const person = await api.addPerson(['manager']);
    manager = await api.signIn(person.email);
  });

  afterAll(async () => {
    await worker?.close();
    await api?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with every step off, saying who hears about it and what blocks turning it on', async () => {
    expect(await entry(SEND_STEP)).toMatchObject({
      group: 'automations',
      value: false,
      default: false,
      reason: 'required',
      licensed: true,
      step: {
        capability: 'fixturesteps.send',
        notifiesCustomer: true,
        turnOn: { ready: false, precondition: SEND_READY },
      },
    });
    expect(await entry(PUSH_STEP)).toMatchObject({
      value: false,
      step: {
        capability: 'fixturesteps.push',
        notifiesCustomer: false,
        turnOn: { ready: false, precondition: 'NO_STOCK_OUT_SOURCE' },
      },
    });
    expect(await workerStates().stateOf(SEND_STEP, { fresh: true })).toMatchObject({
      state: 'off',
      reason: 'step_off',
    });
  });

  it('completes a job of an off step as skipped, acting on nothing (AC-21)', async () => {
    stepStore.records.push({ id: 'r-off', eventAt: new Date().toISOString() });
    const id = await api.app
      .get(JobSender)
      .send(SEND_QUEUE, { records: ['r-off'] }, { step: SEND_STEP });
    await eventually(async () => ((await jobOf(id))?.state === 'completed' ? true : undefined), {
      what: 'the off step job to complete',
    });
    expect((await jobOf(id))?.output).toEqual({ skipped: 'STEP_OFF' });
    expect(stepStore.commands).toEqual([]);
  });

  it('answers the platform precondition before a failing feature one (AC-21, AC-29)', async () => {
    const reply = await turn(PUSH_STEP, true);
    expect(reply.status, JSON.stringify(reply.body)).toBe(409);
    expect(reply.body).toMatchObject({
      code: 'STEP_PRECONDITION',
      precondition: 'NO_STOCK_OUT_SOURCE',
    });
    expect(reply.body).not.toMatchObject({ precondition: PUSH_READY });
    expect((await entry(PUSH_STEP)).value).toBe(false);
    expect(await audited(PUSH_STEP)).toBe(0);
  });

  it('answers NOT_LICENSED before a failing precondition for a step of an unlicensed bundle (AC-21)', async () => {
    const reply = await turn(STOCK_STEP, true);
    expect(reply.status, JSON.stringify(reply.body)).toBe(409);
    expect(reply.body).toMatchObject({ code: 'NOT_LICENSED' });
    expect((await entry(STOCK_STEP)).licensed).toBe(false);
    expect(await audited(STOCK_STEP)).toBe(0);
  });

  it('refuses a step whose feature precondition fails, then takes it with its facts once it passes', async () => {
    const refused = await turn(SEND_STEP, true);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({ code: 'STEP_PRECONDITION', precondition: SEND_READY });
    expect(await audited(SEND_STEP)).toBe(0);

    stepStore.sendReady = true;
    expect((await entry(SEND_STEP)).step?.turnOn).toEqual({
      ready: true,
      facts: [
        {
          label: 'settings.entries.operationsWindDownDays.label',
          values: { stores: 2, variants: 140 },
        },
      ],
    });
    const taken = await turn(SEND_STEP, true);
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    expect(taken.body).toMatchObject({ changed: true, entry: { value: true } });
    expect(await audited(SEND_STEP)).toBe(1);
    // A write of the value in force runs no precondition and writes nothing.
    stepStore.sendReady = false;
    const again = await turn(SEND_STEP, true);
    expect(again.body).toMatchObject({ changed: false });
    stepStore.sendReady = true;
  });

  it('acts only on records whose event is at or after the switch on (AC-27)', async () => {
    await eventually(
      async () =>
        (await workerStates().isRunnable(SEND_STEP, { fresh: true })) ? true : undefined,
      { what: 'the send step to run' },
    );
    const state = await workerStates().stateOf(SEND_STEP, { fresh: true });
    expect(state.state).toBe('on');
    const since = state.state === 'on' ? (state.since as string) : '';
    // The watermark is the instant of the write that switched the step on (AC-27).
    expect(since).toBe((await entry(SEND_STEP)).updatedAt);
    const yesterday = new Date(Date.parse(since) - 24 * 3_600_000).toISOString();
    const later = new Date(Date.parse(since) + 1_000).toISOString();
    stepStore.records.push(
      { id: 'r-yesterday', eventAt: yesterday },
      { id: 'r-today', eventAt: later },
    );
    const id = await api.app
      .get(JobSender)
      .send(SEND_QUEUE, { records: ['r-yesterday', 'r-today'] }, { step: SEND_STEP });
    await eventually(async () => ((await jobOf(id))?.state === 'completed' ? true : undefined), {
      what: 'the send job to complete',
    });
    expect((await jobOf(id))?.output).toEqual({ acted: ['r-today'] });
    expect(stepStore.commands.map((c) => c.recordId)).toEqual(['r-today']);
  });

  it('turning a step off cancels its queued executions and fails its waiting commands with STEP_OFF (AC-21)', async () => {
    const queued = await api.app
      .get(JobSender)
      .send(SEND_QUEUE, { records: ['r-today'] }, { step: SEND_STEP, startAfter: 3_600 });
    stepStore.commands.push({
      id: 'waiting-1',
      recordId: 'r-next',
      state: 'waiting',
      reason: null,
    });
    expect((await jobOf(queued))?.state).toBe('created');

    const off = await turn(SEND_STEP, false);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await eventually(
      async () =>
        (await jobOf(queued))?.state === 'cancelled' &&
        stepStore.commands.find((c) => c.id === 'waiting-1')?.state === 'failed'
          ? true
          : undefined,
      { what: 'the send step to stop' },
    );
    expect(stepStore.commands.find((c) => c.id === 'waiting-1')).toMatchObject({
      state: 'failed',
      reason: 'STEP_OFF',
    });
    expect(await workerStates().stateOf(SEND_STEP, { fresh: true })).toMatchObject({
      state: 'off',
      reason: 'step_off',
    });
  });
});
