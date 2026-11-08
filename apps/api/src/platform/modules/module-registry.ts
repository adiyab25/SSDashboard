import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  capabilitiesByKey,
  MODULE_REGISTRY,
  moduleKeyOfToggle,
  moduleToggleSettings,
  SETTING_DEFINITIONS,
  settingDefinitionOf,
  type ModuleDefinition,
  type PlacedCapability,
  type SettingDefinition,
} from '@ssdashboard/contracts';

/**
 * The injection token of the module rows the api runs with: `MODULE_REGISTRY` from
 * `@ssdashboard/contracts` in every process. A test overrides it to add fixture modules (spec
 * 0009 task 19); production code never does.
 */
export const MODULE_ROWS = Symbol('MODULE_ROWS');

/**
 * The injection token of executing step settings the api runs with beyond the settings registry:
 * none in production, where every step is an entry of `@ssdashboard/contracts`. A test provides a
 * fixture step here (with `MODULE_ROWS` naming it in its capability's `steps`), so the one settings
 * read and write path serves it (spec 0009 task 23). `ModuleRegistry` refuses at construction an
 * entry that reuses a registry setting's or a module toggle's key, is not an `executing_step`,
 * does not default to false, or is not listed in exactly one capability's `steps`
 * (`StepSettingInvalid`).
 */
export const STEP_SETTING_ROWS = Symbol('STEP_SETTING_ROWS');

/** Raised at start for a `STEP_SETTING_ROWS` entry that breaks the executing step rules (AC-6, AC-21). */
export class StepSettingInvalid extends Error {
  /** Takes the step key and what is wrong with it. */
  constructor(key: string, problem: string) {
    super(`Step setting ${key} ${problem}`);
    this.name = 'StepSettingInvalid';
  }
}

/**
 * The module and capability registry as the api reads it (spec 0009, AC-6): the rows, a
 * capability by key with its module, and the settings registry widened with each toggleable
 * module's switch `module.<key>.enabled` (AC-12), so the one settings read and write path serves
 * toggles too. Pure lookups over immutable rows; it never reads a database.
 */
@Injectable()
export class ModuleRegistry {
  private readonly rows: readonly ModuleDefinition[];
  private readonly byModule: ReadonlyMap<string, ModuleDefinition>;
  private readonly byCapability: ReadonlyMap<string, PlacedCapability>;
  private readonly toggles: ReadonlyMap<string, SettingDefinition>;
  private readonly extraSteps: ReadonlyMap<string, SettingDefinition>;

  /**
   * Takes the module rows (without the token, a unit test, the registry of
   * `@ssdashboard/contracts`) and any step settings beyond the settings registry (a test's).
   */
  constructor(
    @Optional() @Inject(MODULE_ROWS) rows?: readonly ModuleDefinition[],
    @Optional() @Inject(STEP_SETTING_ROWS) steps?: readonly SettingDefinition[],
  ) {
    this.rows = rows ?? MODULE_REGISTRY;
    this.byModule = new Map(this.rows.map((module) => [module.key, module]));
    this.byCapability = capabilitiesByKey(this.rows);
    this.toggles = new Map(
      moduleToggleSettings(this.rows).map((setting) => [setting.key, setting as SettingDefinition]),
    );
    this.extraSteps = new Map((steps ?? []).map((setting) => [setting.key, setting]));
    for (const setting of this.extraSteps.values()) {
      if (settingDefinitionOf(setting.key) !== undefined || this.toggles.has(setting.key)) {
        throw new StepSettingInvalid(setting.key, 'reuses the key of a registry setting');
      }
      if (setting.kind !== 'executing_step') {
        throw new StepSettingInvalid(setting.key, 'is not an executing_step');
      }
      if (setting.default !== false)
        throw new StepSettingInvalid(setting.key, 'must default to false');
      const listedBy = this.rows
        .flatMap((module) => module.capabilities)
        .filter((capability) => capability.steps?.includes(setting.key) === true);
      if (listedBy.length !== 1) {
        throw new StepSettingInvalid(setting.key, 'must be listed in exactly one capability');
      }
    }
  }

  /** Every module, in registry order. */
  modules(): readonly ModuleDefinition[] {
    return this.rows;
  }

  /** One module by key, or undefined. */
  module(key: string): ModuleDefinition | undefined {
    return this.byModule.get(key);
  }

  /** One capability with its module, or undefined. */
  capability(key: string): PlacedCapability | undefined {
    return this.byCapability.get(key);
  }

  /** Every capability key, in registry order. */
  capabilityKeys(): string[] {
    return [...this.byCapability.keys()];
  }

  /** The settings entry of a key: a registry setting, a toggleable module's switch, or a test step. */
  settingDefinition(key: string): SettingDefinition | undefined {
    return settingDefinitionOf(key) ?? this.toggles.get(key) ?? this.extraSteps.get(key);
  }

  /** Every settings entry in screen order: the registry's, each module toggle, then any test step. */
  settingDefinitions(): SettingDefinition[] {
    return [
      ...(SETTING_DEFINITIONS as readonly SettingDefinition[]),
      ...this.toggles.values(),
      ...this.extraSteps.values(),
    ];
  }

  /** The keys of every module toggle setting, in registry order. */
  toggleKeys(): string[] {
    return [...this.toggles.keys()];
  }

  /** The toggleable module a settings key switches, or undefined for any other key. */
  toggledModule(settingKey: string): ModuleDefinition | undefined {
    const key = moduleKeyOfToggle(settingKey);
    const module = key === undefined ? undefined : this.byModule.get(key);
    return module?.toggle ? module : undefined;
  }

  /**
   * Whether a module or capability is always `on` whatever the license, toggles, and steps say:
   * a core module without a toggle, or a core capability of one with no `requiresOneOf`. Callers
   * skip the state reads for these, so the routes and jobs of today never query for their state.
   */
  alwaysOn(key: string): boolean {
    const module = this.byModule.get(key);
    if (module) return module.bundle === 'core' && !module.toggle;
    const placed = this.byCapability.get(key);
    if (!placed) return false;
    const { capability, module: owner } = placed;
    return (
      capability.bundle === 'core' &&
      capability.requiresOneOf === undefined &&
      owner.bundle === 'core' &&
      !owner.toggle
    );
  }
}
