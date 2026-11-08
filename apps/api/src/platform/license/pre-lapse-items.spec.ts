import { Logger } from '@nestjs/common';
import { defineModule, MODULE_REGISTRY, type ModuleDefinition } from '@ssdashboard/contracts';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CapabilityHooks } from '../modules/capability-hooks.js';
import { ModuleRegistry } from '../modules/module-registry.js';
import { PreLapseItems } from './pre-lapse-items.js';

// Spec 0009, AC-15, AC-18: the open wind down items whose zero ends the wind down early.

const CARRIER = defineModule({
  key: 'carrier',
  bundle: 'core',
  toggle: false,
  requires: [],
  label: 'modules.platform.label',
  description: 'modules.platform.description',
  capabilities: [
    {
      key: 'carrier.sweep',
      bundle: 'operations',
      kind: 'read',
      windDown: 'pre_lapse',
      workOf: [],
      label: 'modules.capabilities.mailSend',
    },
    {
      key: 'carrier.matching',
      bundle: 'operations',
      kind: 'write',
      windDown: 'pre_lapse',
      workOf: [],
      label: 'modules.capabilities.mailSend',
    },
    {
      key: 'carrier.report',
      bundle: 'warehouse',
      kind: 'read',
      windDown: 'pre_lapse',
      workOf: [],
      label: 'modules.capabilities.mailSend',
    },
  ],
});
const CUT = { before: '2027-04-14T22:00:00.000000Z', pickupWindowEndsAt: '2027-04-17T22:00:00Z' };

function setup(modules: readonly ModuleDefinition[] = [...MODULE_REGISTRY, CARRIER]) {
  const registry = new ModuleRegistry(modules);
  const hooks = new CapabilityHooks(registry);
  return { hooks, items: new PreLapseItems(registry, hooks) };
}

describe('PreLapseItems', () => {
  let warn: MockInstance<Logger['warn']>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  it('sums every Operations pre lapse capability, passing the whole cut', async () => {
    const { hooks, items } = setup();
    const sweep = vi.fn(() => Promise.resolve(2));
    hooks.register('carrier.sweep', { openItems: sweep });
    hooks.register('carrier.matching', { openItems: () => Promise.resolve(0) });
    expect(await items.count(CUT)).toBe(2);
    expect(sweep).toHaveBeenCalledWith(CUT);
  });

  it('answers null when an Operations pre lapse capability has no hook (AC-18)', async () => {
    const { hooks, items } = setup();
    hooks.register('carrier.sweep', { openItems: () => Promise.resolve(0) });
    expect(await items.count(CUT)).toBeNull();
  });

  it('answers null when no Operations pre lapse capability exists', async () => {
    const { items } = setup(MODULE_REGISTRY);
    expect(await items.count(CUT)).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '3', null])(
    'treats an answer of %s as a failed hook, logging the capability key only',
    async (answer) => {
      const { hooks, items } = setup();
      hooks.register('carrier.sweep', { openItems: () => Promise.resolve(answer as number) });
      hooks.register('carrier.matching', { openItems: () => Promise.resolve(0) });
      expect(await items.count(CUT)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        'Open wind down items of carrier.sweep could not be counted',
      );
    },
  );

  it('treats a hook that throws as failed, never printing its error', async () => {
    const { hooks, items } = setup();
    hooks.register('carrier.sweep', {
      openItems: () => Promise.reject(new Error('Failed query: select 1 params: 01001234567')),
    });
    hooks.register('carrier.matching', { openItems: () => Promise.resolve(0) });
    expect(await items.count(CUT)).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('01001234567');
  });

  it('never loops when a hook asks for the count again: the nested count is unknown', async () => {
    const { hooks, items } = setup();
    let nested = 0;
    hooks.register('carrier.sweep', {
      openItems: async (cut) => {
        nested += 1;
        // A hook that calls back into the license: its count answers null at once.
        const inner = await items.count({
          before: cut.before,
          pickupWindowEndsAt: cut.pickupWindowEndsAt ?? cut.before,
        });
        return inner ?? -1;
      },
    });
    hooks.register('carrier.matching', { openItems: () => Promise.resolve(0) });
    expect(await items.count(CUT)).toBeNull();
    expect(nested).toBe(1);
    // A later count, outside the first one's flow, counts again.
    expect(await items.count(CUT)).toBeNull();
    expect(nested).toBe(2);
  });
});
