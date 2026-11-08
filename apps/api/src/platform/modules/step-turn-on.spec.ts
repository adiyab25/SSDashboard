import { Logger } from '@nestjs/common';
import {
  defineModule,
  MODULE_REGISTRY,
  type EffectiveState,
  type StepFact,
} from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityHookConflict, CapabilityHooks } from './capability-hooks.js';
import { ModuleRegistry } from './module-registry.js';
import { UnknownModuleKey, type ModuleStateService } from './module-state.service.js';
import { StepTurnOnCheck } from './step-turn-on.js';

// Spec 0009, AC-21, AC-29: the turn on check of an executing step, in the spec's order.

const STEP = 'step.ops_send';
const OPS = defineModule({
  key: 'ops',
  bundle: 'operations',
  toggle: true,
  requires: [],
  label: 'modules.platform.label',
  description: 'modules.platform.description',
  capabilities: [
    {
      key: 'ops.send',
      bundle: 'operations',
      kind: 'write',
      windDown: 'none',
      requiresOneOf: [],
      workOf: [],
      steps: [STEP],
      label: 'modules.capabilities.mailSend',
    },
  ],
});

function setup(state: EffectiveState) {
  const registry = new ModuleRegistry([...MODULE_REGISTRY, OPS]);
  const hooks = new CapabilityHooks(registry);
  const stateOf = vi.fn(() => Promise.resolve(state));
  const check = new StepTurnOnCheck(registry, hooks, {
    stateOf,
  } as unknown as ModuleStateService);
  return { hooks, check, stateOf };
}

const on: EffectiveState = { state: 'on', since: null };

describe('StepTurnOnCheck', () => {
  it('answers NO_STOCK_OUT_SOURCE first, before any feature precondition runs', async () => {
    const { hooks, check } = setup({
      state: 'read_only',
      reason: 'no_stock_out_source',
      since: null,
    });
    const feature = vi.fn(() => Promise.resolve({ ok: false as const }));
    hooks.registerPreconditions(STEP, [{ code: 'FEATURE_NOT_READY', check: feature }]);
    expect(await check.check(STEP)).toEqual({ ready: false, precondition: 'NO_STOCK_OUT_SOURCE' });
    expect(feature).not.toHaveBeenCalled();
  });

  it('lets a step be switched on while its capability is stopped for another reason (S1)', async () => {
    const { check } = setup({ state: 'read_only', reason: 'toggled_off', since: null });
    expect(await check.check(STEP)).toEqual({ ready: true, facts: [] });
  });

  it('runs feature preconditions in order and answers the first that fails', async () => {
    const { hooks, check } = setup(on);
    const later = vi.fn(() => Promise.resolve({ ok: true as const }));
    hooks.registerPreconditions(STEP, [
      { code: 'FIRST_OK', check: () => Promise.resolve({ ok: true }) },
      { code: 'SECOND_FAILS', check: () => Promise.resolve({ ok: false }) },
      { code: 'THIRD', check: later },
    ]);
    expect(await check.check(STEP)).toEqual({ ready: false, precondition: 'SECOND_FAILS' });
    expect(later).not.toHaveBeenCalled();
  });

  it('collects the facts of passing preconditions and drops malformed ones', async () => {
    const { hooks, check, stateOf } = setup(on);
    hooks.registerPreconditions(STEP, [
      {
        code: 'COUNTS',
        check: () =>
          Promise.resolve({
            ok: true,
            facts: [
              { label: 'settings.steps.facts.confirmed', values: { stores: 2, variants: 140 } },
              { label: 'x', values: { name: 'Ahmed' } } as unknown as StepFact,
            ],
          }),
      },
    ]);
    expect(await check.check(STEP, { fresh: true })).toEqual({
      ready: true,
      facts: [{ label: 'settings.steps.facts.confirmed', values: { stores: 2, variants: 140 } }],
    });
    expect(stateOf).toHaveBeenCalledWith('ops.send', { fresh: true });
  });

  it('counts a precondition that throws as failed, logging only its code', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { hooks, check } = setup(on);
    hooks.registerPreconditions(STEP, [
      { code: 'BROKEN', check: () => Promise.reject(new Error('provider said 01012345678')) },
    ]);
    expect(await check.check(STEP)).toEqual({ ready: false, precondition: 'BROKEN' });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('01012345678');
    warn.mockRestore();
  });

  it('refuses a key no capability lists as a step', async () => {
    const { check } = setup(on);
    await expect(check.check('step.nope')).rejects.toBeInstanceOf(UnknownModuleKey);
  });
});

describe('CapabilityHooks.registerPreconditions', () => {
  it('refuses an unknown step, a second registration, a bad, repeated, or platform code', () => {
    const { hooks } = setup(on);
    const ok = () => Promise.resolve({ ok: true as const });
    expect(() => hooks.registerPreconditions('step.nope', [])).toThrow(CapabilityHookConflict);
    expect(() => hooks.registerPreconditions(STEP, [{ code: 'lower', check: ok }])).toThrow(
      CapabilityHookConflict,
    );
    expect(() =>
      hooks.registerPreconditions(STEP, [{ code: 'NO_STOCK_OUT_SOURCE', check: ok }]),
    ).toThrow(CapabilityHookConflict);
    expect(() =>
      hooks.registerPreconditions(STEP, [
        { code: 'TWICE', check: ok },
        { code: 'TWICE', check: ok },
      ]),
    ).toThrow(CapabilityHookConflict);
    hooks.registerPreconditions(STEP, [{ code: 'READY', check: ok }]);
    expect(hooks.preconditionsOf(STEP).map((p) => p.code)).toEqual(['READY']);
    expect(() => hooks.registerPreconditions(STEP, [])).toThrow(CapabilityHookConflict);
    expect(hooks.preconditionsOf('step.other')).toEqual([]);
  });
});
