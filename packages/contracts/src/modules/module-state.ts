import { z } from 'zod';
import type { LicenseBundle } from '../license/license-envelope.js';
import type { LicensePhase } from '../license/license-phase.js';
import type { CapabilityDefinition, ModuleDefinition } from './module-definition.js';

/** The four states of a module, capability, or executing step (spec 0009, AC-7). */
export const ModuleStateName = z.enum(['on', 'limited', 'read_only', 'off']);
/** One state. */
export type ModuleStateName = z.infer<typeof ModuleStateName>;

/**
 * Why something is not `on` (spec 0009, AC-7). `requires_off`: a module it requires is not `on`
 * (toggled off, or its bundle lapsed or not licensed), so it reads `read_only` too.
 */
export const StopReason = z.enum([
  'not_licensed',
  'lapsed',
  'toggled_off',
  'step_off',
  'no_stock_out_source',
  'requires_off',
]);
/** One stop reason. */
export type StopReason = z.infer<typeof StopReason>;

/**
 * One effective state (spec 0009, *Effective state*). `on` carries `since`, the instant it last
 * became runnable (null when it has been on since the install: never turned back on, never
 * renewed). `limited` carries `before`: it works only for records opened before that instant.
 * `read_only` and `off` carry the reason and `since`, the instant they took effect when known
 * (the lapse, the toggle off, the step switch off), for the "read only since" notices.
 */
export type EffectiveState =
  | { readonly state: 'on'; readonly since: string | null }
  | {
      readonly state: 'limited';
      readonly before: string;
      readonly reason: 'lapsed' | 'toggled_off';
    }
  | {
      readonly state: 'read_only' | 'off';
      readonly reason: StopReason;
      readonly since: string | null;
    };

/** What a bundle contributes: its live phase, its lapse instant, and its last renewal instant. */
export interface BundleFacts {
  readonly phase: LicensePhase;
  /** Local 00:00 of the lapse day as a UTC instant; null without an expiry. */
  readonly lapsedAt: string | null;
  /** The check that last renewed the bundle out of `wind_down` or `off`; null when never. */
  readonly renewedAt: string | null;
}

/** A boolean setting as `moduleStates` reads it: its value and its row's `updated_at`. */
export interface SwitchFact {
  readonly enabled: boolean;
  /** `settings.updated_at`, null when the key has no row (its default holds). */
  readonly updatedAt: string | null;
}

/**
 * Everything `moduleStates` reads (spec 0009, AC-7): each bundle's facts, each toggleable module's
 * switch (absent: the default, on), each executing step's switch (absent: the default, off), and
 * the open item counts of `until_closed` capabilities (absent: zero), taken at the cut
 * `openItemCuts` names.
 */
export interface ModuleStateInput {
  readonly bundles: Readonly<Record<LicenseBundle, BundleFacts>>;
  readonly toggles: Readonly<Record<string, SwitchFact>>;
  readonly steps: Readonly<Record<string, SwitchFact>>;
  readonly openItems: Readonly<Record<string, number>>;
}

/** Every module, capability, and executing step with its effective state. */
export interface ModuleStates {
  readonly modules: ReadonlyMap<string, EffectiveState>;
  readonly capabilities: ReadonlyMap<string, EffectiveState>;
  readonly steps: ReadonlyMap<string, EffectiveState>;
}

/** Whether jobs of a capability or step in this state may run: `on` or `limited` (AC-10). */
export function isRunnableState(state: EffectiveState): boolean {
  return state.state === 'on' || state.state === 'limited';
}

/** A UTC ISO instant (`…Z`) as text that sorts in time order, the fraction padded to 9 digits. */
function sortableInstant(instant: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(instant);
  return match ? `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}` : undefined;
}

/**
 * Orders two instants: negative when `a` is earlier, positive when later, zero when equal. UTC ISO
 * instants (`…Z`, the form every settings and license instant takes) compare by their text, so
 * microseconds count (`Date.parse` would drop them); any other form falls back to milliseconds.
 * Pure.
 */
export function compareInstants(a: string, b: string): number {
  const left = sortableInstant(a);
  const right = sortableInstant(b);
  if (left !== undefined && right !== undefined) return left < right ? -1 : left > right ? 1 : 0;
  return Math.sign(Date.parse(a) - Date.parse(b));
}

/** The later of two instants (either may be null). Pure. */
function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareInstants(b, a) > 0 ? b : a;
}

/** Where a capability is cut and why, when an `until_closed` rule needs its open item count. */
export interface OpenItemCut {
  readonly capability: string;
  /** Records opened before this instant may still finish. */
  readonly before: string;
}

/** The cut rules 3 and 4 apply to a capability, or undefined when neither applies. */
function cutOf(
  capability: CapabilityDefinition,
  module: ModuleDefinition,
  input: Omit<ModuleStateInput, 'openItems'>,
): { before: string | null; reason: 'lapsed' | 'toggled_off' } | undefined {
  if (capability.bundle !== 'core') {
    const facts = input.bundles[capability.bundle];
    if (facts.phase === 'off') return { before: facts.lapsedAt, reason: 'lapsed' };
    if (facts.phase === 'not_licensed' || facts.phase === 'wind_down') return undefined;
  }
  const toggle = module.toggle ? input.toggles[module.key] : undefined;
  if (toggle && !toggle.enabled) return { before: toggle.updatedAt, reason: 'toggled_off' };
  return undefined;
}

/**
 * The `until_closed` capabilities whose state hangs on their open item count right now (rule 3,
 * the bundle `off`; rule 4, the module toggled off), each with the instant before which its
 * records still count. The api asks each one's `openItems` hook for exactly these. Pure.
 */
export function openItemCuts(
  modules: readonly ModuleDefinition[],
  input: Omit<ModuleStateInput, 'openItems'>,
): OpenItemCut[] {
  const cuts: OpenItemCut[] = [];
  for (const module of modules) {
    for (const capability of module.capabilities) {
      if (capability.windDown !== 'until_closed') continue;
      const cut = cutOf(capability, module, input);
      if (cut?.before) cuts.push({ capability: capability.key, before: cut.before });
    }
  }
  return cuts;
}

/**
 * Every module's, capability's, and executing step's state (spec 0009, AC-7, *Effective state*).
 * A module m's own state, first matching rule wins: its bundle not licensed gives `off`
 * (`not_licensed`); its bundle in its wind down or `off` gives `read_only` (`lapsed`); toggled
 * off gives `read_only` (`toggled_off`); a module it `requires` that is not `on` gives `read_only`
 * (`requires_off`); else `on`, since the later of its turn on and its bundle's renewal. A module
 * is never `limited`: only its finishing capabilities are, and their routes declare them
 * (`@RequiresCapability`). A core module without a toggle that requires nothing is always `on`.
 * A capability c of module m in bundle b, first matching rule wins:
 * 1. b is not core and not licensed: `off` (`not_licensed`);
 * 2. b is in its wind down: `limited` before the lapse for `pre_lapse` and `until_closed`, else
 *    `read_only` (`lapsed`);
 * 3. b is `off`: `limited` before the lapse for `until_closed` with open items, else `read_only`
 *    (`lapsed`);
 * 4. m is toggled off: `limited` before the toggle off for `until_closed` with open items, else
 *    `read_only` (`toggled_off`);
 * 5. a module m `requires` is not `on`: `read_only` (`requires_off`), judged from m's
 *    `requires` itself, so it holds for a core capability of a lapsed module too;
 * 6. c has `requiresOneOf` and none of those is `on` (an empty list never is): `read_only`
 *    (`no_stock_out_source`);
 * 7. else `on`, since the later of m's turn on and b's renewal.
 * A step s of capability c: c `off` or `read_only` gives the same; c `limited` gives `read_only`
 * with c's reason (a step never finishes old work); s switched off gives `off` (`step_off`); else
 * `on` since the later of c's `since` and the step's switch on. Pure: it reads no clock and no
 * database.
 */
export function moduleStates(
  modules: readonly ModuleDefinition[],
  input: ModuleStateInput,
): ModuleStates {
  const byKey = new Map(modules.map((module) => [module.key, module]));
  const moduleMap = new Map<string, EffectiveState>();
  const resolvingModules = new Set<string>();
  const moduleState = (key: string): EffectiveState => {
    const known = moduleMap.get(key);
    if (known) return known;
    const module = byKey.get(key);
    // An unknown module (or a loop, which the registry checks refuse) is never `on`.
    if (!module || resolvingModules.has(key)) {
      return { state: 'off', reason: 'not_licensed', since: null };
    }
    resolvingModules.add(key);
    const state = moduleRules(module, input, moduleState);
    resolvingModules.delete(key);
    moduleMap.set(key, state);
    return state;
  };
  for (const module of modules) moduleState(module.key);

  const placed = new Map<string, { capability: CapabilityDefinition; module: ModuleDefinition }>();
  for (const module of modules) {
    for (const capability of module.capabilities) {
      placed.set(capability.key, { capability, module });
    }
  }
  const capabilities = new Map<string, EffectiveState>();
  const resolving = new Set<string>();

  const capabilityState = (key: string): EffectiveState => {
    const known = capabilities.get(key);
    if (known) return known;
    const found = placed.get(key);
    // An unknown source (or a loop, which the registry checks refuse) is never `on`.
    if (!found || resolving.has(key)) {
      return { state: 'off', reason: 'not_licensed', since: null };
    }
    resolving.add(key);
    const state = capabilityRules(found.capability, found.module);
    resolving.delete(key);
    capabilities.set(key, state);
    return state;
  };

  const capabilityRules = (
    capability: CapabilityDefinition,
    module: ModuleDefinition,
  ): EffectiveState => {
    const facts = capability.bundle === 'core' ? undefined : input.bundles[capability.bundle];
    const open = (input.openItems[capability.key] ?? 0) > 0;
    if (facts) {
      if (facts.phase === 'not_licensed')
        return { state: 'off', reason: 'not_licensed', since: null };
      if (facts.phase === 'wind_down') {
        return capability.windDown !== 'none' && facts.lapsedAt !== null
          ? { state: 'limited', before: facts.lapsedAt, reason: 'lapsed' }
          : { state: 'read_only', reason: 'lapsed', since: facts.lapsedAt };
      }
      if (facts.phase === 'off') {
        return capability.windDown === 'until_closed' && open && facts.lapsedAt !== null
          ? { state: 'limited', before: facts.lapsedAt, reason: 'lapsed' }
          : { state: 'read_only', reason: 'lapsed', since: facts.lapsedAt };
      }
    }
    const toggle = module.toggle ? input.toggles[module.key] : undefined;
    if (toggle && !toggle.enabled) {
      return capability.windDown === 'until_closed' && open && toggle.updatedAt !== null
        ? { state: 'limited', before: toggle.updatedAt, reason: 'toggled_off' }
        : { state: 'read_only', reason: 'toggled_off', since: toggle.updatedAt };
    }
    if (module.requires.some((required) => moduleState(required).state !== 'on')) {
      return { state: 'read_only', reason: 'requires_off', since: null };
    }
    if (capability.requiresOneOf !== undefined) {
      const sourced = capability.requiresOneOf.some((source) => {
        return capabilityState(source).state === 'on';
      });
      if (!sourced) return { state: 'read_only', reason: 'no_stock_out_source', since: null };
    }
    return {
      state: 'on',
      since: latest(toggle?.enabled ? toggle.updatedAt : null, facts?.renewedAt ?? null),
    };
  };

  for (const key of placed.keys()) capabilityState(key);

  const steps = new Map<string, EffectiveState>();
  for (const { capability } of placed.values()) {
    const gate = capabilities.get(capability.key) as EffectiveState;
    for (const step of capability.steps ?? []) {
      steps.set(step, stepRules(gate, input.steps[step]));
    }
  }
  return { modules: moduleMap, capabilities, steps };
}

/**
 * A module's own state: its bundle, its toggle, then its `requires` (never `limited`). The
 * required modules' states come from `stateOf`.
 */
function moduleRules(
  module: ModuleDefinition,
  input: ModuleStateInput,
  stateOf: (key: string) => EffectiveState,
): EffectiveState {
  const facts = module.bundle === 'core' ? undefined : input.bundles[module.bundle];
  if (facts) {
    if (facts.phase === 'not_licensed')
      return { state: 'off', reason: 'not_licensed', since: null };
    if (facts.phase === 'wind_down' || facts.phase === 'off') {
      return { state: 'read_only', reason: 'lapsed', since: facts.lapsedAt };
    }
  }
  const toggle = module.toggle ? input.toggles[module.key] : undefined;
  if (toggle && !toggle.enabled) {
    return { state: 'read_only', reason: 'toggled_off', since: toggle.updatedAt };
  }
  if (module.requires.some((required) => stateOf(required).state !== 'on')) {
    return { state: 'read_only', reason: 'requires_off', since: null };
  }
  return {
    state: 'on',
    since: latest(toggle?.enabled ? toggle.updatedAt : null, facts?.renewedAt ?? null),
  };
}

/** An executing step's state from its capability's and its own switch (rules S1 to S4). */
function stepRules(gate: EffectiveState, stepSwitch: SwitchFact | undefined): EffectiveState {
  switch (gate.state) {
    case 'off':
    case 'read_only':
      return gate;
    case 'limited':
      return { state: 'read_only', reason: gate.reason, since: gate.before };
    case 'on':
      if (!stepSwitch?.enabled) {
        return { state: 'off', reason: 'step_off', since: stepSwitch?.updatedAt ?? null };
      }
      return { state: 'on', since: latest(gate.since, stepSwitch.updatedAt) };
  }
}
