import { Logger } from '@nestjs/common';
import { defineModule, MODULE_REGISTRY } from '@ssdashboard/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingError } from '../settings/settings.errors.js';
import { CapabilityHooks } from './capability-hooks.js';
import { moduleHttpError, OffImpactUnavailable } from './module.errors.js';
import { ModuleRegistry } from './module-registry.js';
import { OffImpactReader } from './off-impact.js';

const OPS = defineModule({
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
    {
      key: 'ops.finish',
      bundle: 'operations',
      kind: 'write',
      windDown: 'until_closed',
      workOf: [],
      label: 'modules.capabilities.mailSend',
    },
  ],
});

const PARTNER = {
  partnerId: '0190c0de-0000-7000-8000-00000000f001',
  partnerName: 'Showroom',
  pieces: 3,
  totalValue: '90.00',
  lastConfirmedSalesDay: null,
};

function setup() {
  const registry = new ModuleRegistry([...MODULE_REGISTRY, OPS]);
  const hooks = new CapabilityHooks(registry);
  hooks.registerCommands({
    failWaitingCommands: () => Promise.resolve(0),
    waitingCommands: (capability) =>
      Promise.resolve(
        capability === 'ops.queue'
          ? [
              { kind: 'ops.push', count: 2 },
              { kind: 'ops.cancel', count: 1 },
            ]
          : [{ kind: 'ops.push', count: 3 }],
      ),
  });
  return { hooks, reader: new OffImpactReader(registry, hooks) };
}

// Spec 0009, AC-30: what turning a module off drops.
describe('OffImpactReader (AC-30)', () => {
  beforeEach(() => vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('sums the waiting commands by kind and merges every capability impact', async () => {
    const { hooks, reader } = setup();
    hooks.register('ops.queue', {
      offImpact: () => Promise.resolve({ inFlight: [{ area: 'returns', count: 1 }] }),
    });
    hooks.register('ops.finish', {
      offImpact: () =>
        Promise.resolve({ inFlight: [{ area: 'returns', count: 2 }], partnerStock: [PARTNER] }),
    });

    const impact = await reader.read('module.ops.enabled', { showCost: false });

    expect(impact).toEqual({
      waitingCommands: [
        { kind: 'ops.push', count: 5 },
        { kind: 'ops.cancel', count: 1 },
      ],
      inFlight: [{ area: 'returns', count: 3 }],
      partnerStock: [
        {
          partnerId: PARTNER.partnerId,
          partnerName: 'Showroom',
          pieces: 3,
          lastConfirmedSalesDay: null,
        },
      ],
      typedConfirmation: true,
    });
    expect((await reader.read('module.ops.enabled', { showCost: true })).partnerStock).toEqual([
      PARTNER,
    ]);
  });

  it('asks for no typed confirmation when nothing is held and no hook asks', async () => {
    const { reader } = setup();
    expect((await reader.read('module.ops.enabled', { showCost: false })).typedConfirmation).toBe(
      false,
    );
  });

  it('refuses a key that is neither a module switch nor a step', async () => {
    const { reader } = setup();
    await expect(reader.read('timezone', { showCost: false })).rejects.toMatchObject({
      kind: 'SettingUnknown',
    });
    await expect(
      reader.read('module.platform.enabled', { showCost: false }),
    ).rejects.toBeInstanceOf(SettingError);
  });

  it('answers 503 OFF_IMPACT_UNAVAILABLE when a hook throws, never a guess', async () => {
    const { hooks, reader } = setup();
    hooks.register('ops.finish', {
      offImpact: () => Promise.reject(new Error('failed query')),
    });

    const failure = await reader
      .read('module.ops.enabled', { showCost: false })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(OffImpactUnavailable);
    const answer = moduleHttpError(failure);
    expect(answer?.getStatus()).toBe(503);
    expect(answer?.getResponse()).toMatchObject({ code: 'OFF_IMPACT_UNAVAILABLE' });
  });
});
