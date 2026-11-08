import { describe, expect, it } from 'vitest';
import type { LicensePhase } from '../license/license-phase.js';
import type { SettingBundle } from '../settings/setting-definition.js';
import { defineModule, type ModuleDefinition, type WindDown } from './module-definition.js';
import { MODULE_REGISTRY } from './module-registry.js';
import {
  compareInstants,
  isRunnableState,
  moduleStates,
  openItemCuts,
  type BundleFacts,
  type EffectiveState,
  type ModuleStateInput,
  type SwitchFact,
} from './module-state.js';

const LAPSED = '2027-04-15T22:00:00.000000Z';
const RENEWED = '2027-06-01T08:00:00.000000Z';
const TOGGLED = '2027-05-01T09:00:00.000000Z';
const STEP_ON = '2027-05-20T10:00:00.000000Z';

const PHASES: readonly LicensePhase[] = [
  'not_licensed',
  'active',
  'expiring',
  'grace',
  'wind_down',
  'off',
];
const WIND_DOWNS: readonly WindDown[] = ['none', 'pre_lapse', 'until_closed'];
const BUNDLES: readonly SettingBundle[] = ['core', 'warehouse', 'operations'];
/** absent: no row (the default, on); on and off: a row written at `TOGGLED`. */
const TOGGLES = ['absent', 'on', 'off'] as const;
/** The `requiresOneOf` rule of the capability under test, against a source in a core module. */
const SOURCES = ['none', 'empty', 'source_on', 'source_off'] as const;
const STEPS = ['absent', 'on', 'off'] as const;

const facts = (phase: LicensePhase): BundleFacts => ({
  phase,
  lapsedAt: phase === 'not_licensed' ? null : LAPSED,
  renewedAt: phase === 'active' ? RENEWED : null,
});

interface Case {
  bundle: SettingBundle;
  phase: LicensePhase;
  windDown: WindDown;
  toggle: (typeof TOGGLES)[number];
  openItems: number;
  source: (typeof SOURCES)[number];
  step: (typeof STEPS)[number];
}

/** The module under test (toggleable, in the capability's bundle) and a core source module. */
function registryOf(c: Case): ModuleDefinition[] {
  const moduleBundle = c.bundle === 'core' ? 'operations' : c.bundle;
  return [
    defineModule({
      key: 'source',
      bundle: 'core',
      toggle: false,
      requires: [],
      label: 'modules.platform.label',
      description: 'modules.platform.description',
      capabilities: [
        {
          key: 'source.out',
          bundle: c.source === 'source_off' ? 'warehouse' : 'core',
          kind: 'write',
          windDown: 'none',
          workOf: [],
          label: 'modules.capabilities.mailSend',
        },
      ],
    }),
    defineModule({
      key: 'subject',
      bundle: moduleBundle,
      toggle: true,
      requires: [],
      label: 'modules.platform.label',
      description: 'modules.platform.description',
      capabilities: [
        {
          key: 'subject.work',
          bundle: c.bundle,
          kind: 'write',
          windDown: c.windDown,
          ...(c.source === 'empty' && { requiresOneOf: [] }),
          ...((c.source === 'source_on' || c.source === 'source_off') && {
            requiresOneOf: ['source.out'],
          }),
          workOf: [],
          steps: ['step.subject'],
          label: 'modules.capabilities.mailSend',
        },
      ],
    }),
  ];
}

function inputOf(c: Case): ModuleStateInput {
  const toggles: Record<string, SwitchFact> =
    c.toggle === 'absent' ? {} : { subject: { enabled: c.toggle === 'on', updatedAt: TOGGLED } };
  const steps: Record<string, SwitchFact> =
    c.step === 'absent' ? {} : { 'step.subject': { enabled: c.step === 'on', updatedAt: STEP_ON } };
  return {
    // The source of `source_off` is a Warehouse capability that is not licensed.
    bundles: {
      warehouse: c.source === 'source_off' ? facts('not_licensed') : facts(c.phase),
      operations: facts(c.phase),
    },
    toggles,
    steps,
    openItems: c.openItems ? { 'subject.work': c.openItems } : {},
  };
}

/** The spec's *Effective state* capability rules, read literally (the oracle of the sweep). */
function expectedCapability(c: Case, input: ModuleStateInput): EffectiveState {
  const phase = c.bundle === 'core' ? undefined : input.bundles[c.bundle].phase;
  const toggledOff = c.toggle === 'off';
  if (phase === 'not_licensed') return { state: 'off', reason: 'not_licensed', since: null };
  if (phase === 'wind_down') {
    return c.windDown === 'pre_lapse' || c.windDown === 'until_closed'
      ? { state: 'limited', before: LAPSED, reason: 'lapsed' }
      : { state: 'read_only', reason: 'lapsed', since: LAPSED };
  }
  if (phase === 'off') {
    return c.windDown === 'until_closed' && c.openItems > 0
      ? { state: 'limited', before: LAPSED, reason: 'lapsed' }
      : { state: 'read_only', reason: 'lapsed', since: LAPSED };
  }
  if (toggledOff) {
    return c.windDown === 'until_closed' && c.openItems > 0
      ? { state: 'limited', before: TOGGLED, reason: 'toggled_off' }
      : { state: 'read_only', reason: 'toggled_off', since: TOGGLED };
  }
  if (c.source === 'empty' || c.source === 'source_off') {
    return { state: 'read_only', reason: 'no_stock_out_source', since: null };
  }
  const turnedOn = c.toggle === 'on' ? TOGGLED : null;
  const renewed = phase === 'active' ? RENEWED : null;
  const candidates = [turnedOn, renewed].filter((x): x is string => x !== null).sort();
  return { state: 'on', since: candidates.at(-1) ?? null };
}

/** Rules S1 to S4 read literally. */
function expectedStep(c: Case, gate: EffectiveState): EffectiveState {
  if (gate.state === 'off' || gate.state === 'read_only') return gate;
  if (gate.state === 'limited')
    return { state: 'read_only', reason: gate.reason, since: gate.before };
  if (c.step !== 'on') {
    return { state: 'off', reason: 'step_off', since: c.step === 'off' ? STEP_ON : null };
  }
  const candidates = [gate.since, STEP_ON].filter((x): x is string => x !== null).sort();
  return { state: 'on', since: candidates.at(-1) ?? null };
}

/** A module's own state read literally (never limited, AC-7 as ruled for code review m3, 1). */
function expectedModule(c: Case, input: ModuleStateInput): EffectiveState {
  const bundle = c.bundle === 'core' ? 'operations' : c.bundle;
  const phase = input.bundles[bundle].phase;
  if (phase === 'not_licensed') return { state: 'off', reason: 'not_licensed', since: null };
  if (phase === 'wind_down' || phase === 'off') {
    return { state: 'read_only', reason: 'lapsed', since: LAPSED };
  }
  if (c.toggle === 'off') return { state: 'read_only', reason: 'toggled_off', since: TOGGLED };
  const candidates = [c.toggle === 'on' ? TOGGLED : null, phase === 'active' ? RENEWED : null]
    .filter((x): x is string => x !== null)
    .sort();
  return { state: 'on', since: candidates.at(-1) ?? null };
}

function* allCases(): Generator<Case> {
  for (const bundle of BUNDLES)
    for (const phase of PHASES)
      for (const windDown of WIND_DOWNS)
        for (const toggle of TOGGLES)
          for (const openItems of [0, 3])
            for (const source of SOURCES)
              for (const step of STEPS)
                yield { bundle, phase, windDown, toggle, openItems, source, step };
}

// Spec 0009, AC-7: one state rule for every module, capability, and executing step.
describe('moduleStates (AC-7)', () => {
  it('gives every combination the state the spec rules give (exhaustive)', () => {
    let checked = 0;
    for (const c of allCases()) {
      const input = inputOf(c);
      const states = moduleStates(registryOf(c), input);
      const capability = states.capabilities.get('subject.work');
      const label = JSON.stringify(c);
      const expected = expectedCapability(c, input);
      expect(capability, label).toEqual(expected);
      expect(states.modules.get('subject'), label).toEqual(expectedModule(c, input));
      expect(states.modules.get('subject')?.state, label).not.toBe('limited');
      expect(states.steps.get('step.subject'), label).toEqual(expectedStep(c, expected));
      // A step is never `limited`, and runnable means on or limited.
      expect(states.steps.get('step.subject')?.state, label).not.toBe('limited');
      expect(isRunnableState(expected)).toBe(
        expected.state === 'on' || expected.state === 'limited',
      );
      checked += 1;
    }
    expect(checked).toBe(3 * 6 * 3 * 3 * 2 * 4 * 3);
  });

  it('keeps every module of today on, with no input at all', () => {
    const states = moduleStates(MODULE_REGISTRY, {
      bundles: { warehouse: facts('not_licensed'), operations: facts('not_licensed') },
      toggles: {},
      steps: {},
      openItems: {},
    });
    for (const module of MODULE_REGISTRY) {
      expect(states.modules.get(module.key)).toEqual({ state: 'on', since: null });
      for (const capability of module.capabilities) {
        expect(states.capabilities.get(capability.key)).toEqual({ state: 'on', since: null });
      }
    }
  });

  it('never runs a capability whose requiresOneOf is empty (AC-29)', () => {
    const c: Case = {
      bundle: 'warehouse',
      phase: 'active',
      windDown: 'none',
      toggle: 'absent',
      openItems: 0,
      source: 'empty',
      step: 'on',
    };
    const states = moduleStates(registryOf(c), inputOf(c));
    expect(states.capabilities.get('subject.work')).toEqual({
      state: 'read_only',
      reason: 'no_stock_out_source',
      since: null,
    });
    expect(states.steps.get('step.subject')?.state).toBe('read_only');
  });

  it('turns a step whose capability is limited read only (S2)', () => {
    const c: Case = {
      bundle: 'operations',
      phase: 'wind_down',
      windDown: 'pre_lapse',
      toggle: 'absent',
      openItems: 0,
      source: 'none',
      step: 'on',
    };
    const states = moduleStates(registryOf(c), inputOf(c));
    expect(states.capabilities.get('subject.work')?.state).toBe('limited');
    expect(states.steps.get('step.subject')).toEqual({
      state: 'read_only',
      reason: 'lapsed',
      since: LAPSED,
    });
  });

  it('gives a module its own state from its bundle and toggle, never limited', () => {
    const at = (
      phase: LicensePhase,
      toggle: Case['toggle'],
      openItems = 0,
      windDown: WindDown = 'until_closed',
    ) => {
      const c: Case = {
        bundle: 'operations',
        phase,
        windDown,
        toggle,
        openItems,
        source: 'none',
        step: 'absent',
      };
      return moduleStates(registryOf(c), inputOf(c)).modules.get('subject');
    };
    expect(at('not_licensed', 'absent')).toEqual({
      state: 'off',
      reason: 'not_licensed',
      since: null,
    });
    expect(at('active', 'absent')).toEqual({ state: 'on', since: RENEWED });
    expect(at('grace', 'on')).toEqual({ state: 'on', since: TOGGLED });
    expect(at('grace', 'off')).toEqual({
      state: 'read_only',
      reason: 'toggled_off',
      since: TOGGLED,
    });
    // A module is never limited, even while a finishing capability is (Igris ruling, code 1).
    expect(at('grace', 'off', 2)).toEqual({
      state: 'read_only',
      reason: 'toggled_off',
      since: TOGGLED,
    });
    expect(at('wind_down', 'absent', 0, 'none')).toEqual({
      state: 'read_only',
      reason: 'lapsed',
      since: LAPSED,
    });
    expect(at('off', 'absent', 1)).toEqual({
      state: 'read_only',
      reason: 'lapsed',
      since: LAPSED,
    });
  });

  it('names the until_closed capabilities whose open items decide their state', () => {
    const c = (phase: LicensePhase, toggle: Case['toggle']): Case => ({
      bundle: 'operations',
      phase,
      windDown: 'until_closed',
      toggle,
      openItems: 0,
      source: 'none',
      step: 'absent',
    });
    const cuts = (k: Case) => openItemCuts(registryOf(k), inputOf(k));
    expect(cuts(c('active', 'absent'))).toEqual([]);
    expect(cuts(c('wind_down', 'off'))).toEqual([]);
    expect(cuts(c('off', 'off'))).toEqual([{ capability: 'subject.work', before: LAPSED }]);
    expect(cuts(c('grace', 'off'))).toEqual([{ capability: 'subject.work', before: TOGGLED }]);
    expect(cuts(c('not_licensed', 'off'))).toEqual([]);
  });

  it('counts only an on source for rule 6: one of two is enough, a limited one is not', () => {
    const modules = [
      defineModule({
        key: 'sources',
        bundle: 'operations',
        toggle: true,
        requires: [],
        label: 'modules.platform.label',
        description: 'modules.platform.description',
        capabilities: [
          {
            key: 'sources.on',
            bundle: 'core',
            kind: 'write',
            windDown: 'none',
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
          {
            key: 'sources.finishing',
            bundle: 'operations',
            kind: 'write',
            windDown: 'until_closed',
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
        ],
      }),
      defineModule({
        key: 'push',
        bundle: 'core',
        toggle: false,
        requires: [],
        label: 'modules.platform.label',
        description: 'modules.platform.description',
        capabilities: [
          {
            key: 'push.both',
            bundle: 'core',
            kind: 'write',
            windDown: 'none',
            requiresOneOf: ['sources.finishing', 'sources.on'],
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
          {
            key: 'push.finishing_only',
            bundle: 'core',
            kind: 'write',
            windDown: 'none',
            requiresOneOf: ['sources.finishing'],
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
        ],
      }),
    ];
    const live = moduleStates(modules, {
      bundles: { warehouse: facts('active'), operations: facts('active') },
      toggles: {},
      steps: {},
      openItems: {},
    });
    expect(live.capabilities.get('push.both')?.state).toBe('on');
    // The sources module toggled off: `sources.finishing` is limited (open items), `sources.on`
    // read only, so neither source is on.
    const off = moduleStates(modules, {
      bundles: { warehouse: facts('active'), operations: facts('active') },
      toggles: { sources: { enabled: false, updatedAt: TOGGLED } },
      steps: {},
      openItems: { 'sources.finishing': 2 },
    });
    expect(off.capabilities.get('sources.finishing')?.state).toBe('limited');
    expect(off.capabilities.get('push.both')).toEqual({
      state: 'read_only',
      reason: 'no_stock_out_source',
      since: null,
    });
    expect(off.capabilities.get('push.finishing_only')?.state).toBe('read_only');
  });

  it('takes the later of the turn on and the renewal for rule 7, whichever it is', () => {
    const c: Case = {
      bundle: 'operations',
      phase: 'active',
      windDown: 'none',
      toggle: 'on',
      openItems: 0,
      source: 'none',
      step: 'absent',
    };
    const later = '2027-07-01T08:00:00.000000Z';
    const input = inputOf(c);
    const turnedOnLater = moduleStates(registryOf(c), {
      ...input,
      toggles: { subject: { enabled: true, updatedAt: later } },
    });
    expect(turnedOnLater.capabilities.get('subject.work')).toEqual({ state: 'on', since: later });
    const renewedLater = moduleStates(registryOf(c), {
      ...input,
      bundles: { ...input.bundles, operations: { ...facts('active'), renewedAt: later } },
    });
    expect(renewedLater.capabilities.get('subject.work')).toEqual({ state: 'on', since: later });
    // Microseconds count: a renewal 1 microsecond after the turn on wins.
    const tie = moduleStates(registryOf(c), {
      ...input,
      toggles: { subject: { enabled: true, updatedAt: '2027-07-01T08:00:00.000001Z' } },
      bundles: {
        ...input.bundles,
        operations: { ...facts('active'), renewedAt: '2027-07-01T08:00:00.000002Z' },
      },
    });
    expect(tie.modules.get('subject')).toEqual({
      state: 'on',
      since: '2027-07-01T08:00:00.000002Z',
    });
  });

  it('never makes a capability limited without a lapse instant', () => {
    const at = (phase: LicensePhase, windDown: WindDown) => {
      const c: Case = {
        bundle: 'operations',
        phase,
        windDown,
        toggle: 'absent',
        openItems: 3,
        source: 'none',
        step: 'absent',
      };
      const input = inputOf(c);
      return moduleStates(registryOf(c), {
        ...input,
        bundles: { ...input.bundles, operations: { phase, lapsedAt: null, renewedAt: null } },
      }).capabilities.get('subject.work');
    };
    const noInstant = { state: 'read_only', reason: 'lapsed', since: null };
    expect(at('wind_down', 'pre_lapse')).toEqual(noInstant);
    expect(at('off', 'until_closed')).toEqual(noInstant);
  });

  it('reads a module whose required module is not on read only, its capabilities too (rule 5)', () => {
    const modules = [
      defineModule({
        key: 'base',
        bundle: 'operations',
        toggle: true,
        requires: [],
        label: 'modules.platform.label',
        description: 'modules.platform.description',
        capabilities: [],
      }),
      defineModule({
        key: 'addon',
        bundle: 'operations',
        toggle: true,
        requires: ['base'],
        label: 'modules.platform.label',
        description: 'modules.platform.description',
        capabilities: [
          {
            key: 'addon.work',
            bundle: 'operations',
            kind: 'write',
            windDown: 'until_closed',
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
        ],
      }),
      defineModule({
        key: 'onwards',
        bundle: 'warehouse',
        toggle: true,
        requires: ['addon'],
        label: 'modules.platform.label',
        description: 'modules.platform.description',
        capabilities: [],
      }),
    ];
    const run = (toggles: Record<string, SwitchFact>, operations: LicensePhase = 'active') =>
      moduleStates(modules, {
        bundles: { warehouse: facts('active'), operations: facts(operations) },
        toggles,
        steps: {},
        openItems: { 'addon.work': 4 },
      });
    const requiresOff = { state: 'read_only', reason: 'requires_off', since: null };

    const live = run({});
    expect(live.modules.get('addon')?.state).toBe('on');
    expect(live.modules.get('onwards')?.state).toBe('on');

    const baseOff = run({ base: { enabled: false, updatedAt: TOGGLED } });
    expect(baseOff.modules.get('addon')).toEqual(requiresOff);
    expect(baseOff.capabilities.get('addon.work')).toEqual(requiresOff);
    // It carries down the chain.
    expect(baseOff.modules.get('onwards')).toEqual(requiresOff);

    // A lapse of the required module's bundle: the Warehouse dependant follows it.
    const lapsed = run({}, 'off');
    expect(lapsed.modules.get('base')).toMatchObject({ state: 'read_only', reason: 'lapsed' });
    expect(lapsed.modules.get('onwards')).toEqual(requiresOff);

    // Its own toggle off comes first.
    const both = run({
      base: { enabled: false, updatedAt: TOGGLED },
      addon: { enabled: false, updatedAt: TOGGLED },
    });
    expect(both.capabilities.get('addon.work')).toMatchObject({
      state: 'limited',
      reason: 'toggled_off',
    });
  });

  it('orders instants by their text, microseconds included', () => {
    const a = '2027-01-01T00:00:00.000001Z';
    expect(compareInstants(a, '2027-01-01T00:00:00.000002Z')).toBeLessThan(0);
    expect(compareInstants('2027-01-01T00:00:00Z', '2027-01-01T00:00:00.000000Z')).toBe(0);
    expect(compareInstants('2027-01-01T00:00:01Z', '2027-01-01T00:00:00.999999Z')).toBeGreaterThan(
      0,
    );
    expect(compareInstants('2027-01-01T02:00:00+02:00', '2027-01-01T00:00:00.000Z')).toBe(0);
  });

  it('applies rule 5 to a core capability of a lapsed module whose required module is off', () => {
    const modules = [
      defineModule({
        key: 'base',
        bundle: 'warehouse',
        toggle: true,
        requires: [],
        label: 'modules.platform.label',
        description: 'modules.platform.description',
        capabilities: [],
      }),
      defineModule({
        key: 'addon',
        bundle: 'operations',
        toggle: true,
        requires: ['base'],
        label: 'modules.platform.label',
        description: 'modules.platform.description',
        capabilities: [
          {
            key: 'addon.core_part',
            bundle: 'core',
            kind: 'read',
            windDown: 'none',
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
        ],
      }),
    ];
    const states = moduleStates(modules, {
      bundles: { warehouse: facts('active'), operations: facts('wind_down') },
      toggles: { base: { enabled: false, updatedAt: TOGGLED } },
      steps: {},
      openItems: {},
    });
    // The module reads lapsed (its own bundle comes first); its core capability still follows
    // rule 5 from the module's requires.
    expect(states.modules.get('addon')).toMatchObject({ state: 'read_only', reason: 'lapsed' });
    expect(states.capabilities.get('addon.core_part')).toEqual({
      state: 'read_only',
      reason: 'requires_off',
      since: null,
    });
  });
});
