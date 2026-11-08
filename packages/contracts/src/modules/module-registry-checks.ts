import type { SettingBundle, SettingKind } from '../settings/setting-definition.js';
import type { CapabilityDefinition, ModuleDefinition } from './module-definition.js';

/** What the checks need to know of a setting a capability's `steps` names. */
export interface StepSettingFacts {
  readonly key: string;
  readonly kind: SettingKind;
  readonly bundle: SettingBundle;
}

/** A capability together with the module that holds it. */
export interface PlacedCapability {
  readonly capability: CapabilityDefinition;
  readonly module: ModuleDefinition;
}

/** Every capability of `modules` by key, with its module; a repeated key keeps the first. Pure. */
export function capabilitiesByKey(
  modules: readonly ModuleDefinition[],
): ReadonlyMap<string, PlacedCapability> {
  const found = new Map<string, PlacedCapability>();
  for (const module of modules) {
    for (const capability of module.capabilities) {
      if (!found.has(capability.key)) found.set(capability.key, { capability, module });
    }
  }
  return found;
}

/** The capability whose `steps` lists `stepKey` (the one it gates, AC-6), or undefined. Pure. */
export function capabilityOfStep(
  modules: readonly ModuleDefinition[],
  stepKey: string,
): PlacedCapability | undefined {
  for (const module of modules) {
    for (const capability of module.capabilities) {
      if (capability.steps?.includes(stepKey)) return { capability, module };
    }
  }
  return undefined;
}

/** Whether following `edges` from any node returns to it. */
function cyclesIn(edges: ReadonlyMap<string, readonly string[]>): string[] {
  const cyclic: string[] = [];
  const done = new Set<string>();
  const walking = new Set<string>();
  const visit = (node: string): boolean => {
    if (done.has(node)) return false;
    if (walking.has(node)) return true;
    walking.add(node);
    const loops = (edges.get(node) ?? []).some((next) => edges.has(next) && visit(next));
    walking.delete(node);
    done.add(node);
    return loops;
  };
  for (const node of edges.keys()) if (visit(node)) cyclic.push(node);
  return cyclic;
}

/**
 * A module key is one lowercase word, so its folder file `<key>/<key>.module.ts` never clashes
 * with the kebab case file names (Igris ruling on code review m3, finding 10).
 */
const MODULE_KEY = /^[a-z][a-z0-9]*$/;
/** A capability name: dot separated snake case words, no empty or doubled separator. */
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;

/**
 * Every rule of spec 0009 AC-6 the module registry must keep, as plain sentences; empty when
 * sound. A `core` module has no toggle and requires only core modules; a required module exists
 * and no `requires` loop exists; a capability key is unique and starts with its module key; a
 * `requiresOneOf` key names a capability and forms no loop; a step names an `executing_step`
 * setting of its capability's bundle and is listed by exactly one capability, and every
 * `executing_step` setting is listed by one. The folder check (a registry module has
 * `apps/api/src/<key>/<key>.module.ts` and back) runs in the api, which owns the folders. Pure.
 */
export function moduleRegistryIssues(
  modules: readonly ModuleDefinition[],
  settings: readonly StepSettingFacts[],
): string[] {
  const issues: string[] = [];
  const byKey = new Map<string, ModuleDefinition>();
  for (const module of modules) {
    if (byKey.has(module.key)) issues.push(`${module.key}: two modules share the key`);
    byKey.set(module.key, module);
    if (!MODULE_KEY.test(module.key))
      issues.push(`${module.key}: a module key is one lowercase word`);
    if (module.bundle === 'core' && module.toggle) {
      issues.push(`${module.key}: a core module never has a toggle`);
    }
  }
  for (const module of modules) {
    for (const required of module.requires) {
      const target = byKey.get(required);
      if (!target) {
        issues.push(`${module.key}: requires ${required}, which is not a module`);
      } else if (module.bundle === 'core' && target.bundle !== 'core') {
        issues.push(`${module.key}: a core module requires the non core module ${required}`);
      }
    }
  }
  for (const looped of cyclesIn(new Map(modules.map((m) => [m.key, m.requires])))) {
    issues.push(`${looped}: its requires form a loop`);
  }

  const capabilities = new Map<string, CapabilityDefinition>();
  for (const module of modules) {
    for (const capability of module.capabilities) {
      if (capabilities.has(capability.key)) {
        issues.push(`${capability.key}: two capabilities share the key`);
      }
      capabilities.set(capability.key, capability);
      const name = capability.key.slice(module.key.length + 1);
      if (!capability.key.startsWith(`${module.key}.`) || !CAPABILITY_NAME.test(name)) {
        issues.push(`${capability.key}: a capability key is <module>.<name> of ${module.key}`);
      }
    }
  }
  for (const capability of capabilities.values()) {
    for (const source of capability.requiresOneOf ?? []) {
      if (!capabilities.has(source)) {
        issues.push(`${capability.key}: requiresOneOf names ${source}, which is not a capability`);
      }
    }
  }
  const sources = new Map(
    [...capabilities.values()].map((c) => [c.key, c.requiresOneOf ?? []] as const),
  );
  for (const looped of cyclesIn(sources)) {
    issues.push(`${looped}: its requiresOneOf form a loop`);
  }

  const settingByKey = new Map(settings.map((setting) => [setting.key, setting]));
  const listedBy = new Map<string, string[]>();
  for (const capability of capabilities.values()) {
    for (const step of capability.steps ?? []) {
      listedBy.set(step, [...(listedBy.get(step) ?? []), capability.key]);
      const setting = settingByKey.get(step);
      if (!setting || setting.kind !== 'executing_step') {
        issues.push(`${capability.key}: step ${step} is not an executing_step setting`);
      } else if (setting.bundle !== capability.bundle) {
        issues.push(`${capability.key}: step ${step} is not in the capability's bundle`);
      }
    }
  }
  for (const [step, by] of listedBy) {
    if (by.length > 1) issues.push(`${step}: a step is listed by ${by.join(' and ')}`);
  }
  for (const setting of settings) {
    if (setting.kind === 'executing_step' && !listedBy.has(setting.key)) {
      issues.push(`${setting.key}: an executing step is listed by no capability`);
    }
  }
  return issues;
}
