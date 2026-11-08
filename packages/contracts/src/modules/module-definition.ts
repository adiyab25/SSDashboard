import type { MessageKey } from '@ssdashboard/i18n';
import { z } from 'zod';
import type { Permission } from '../access.js';
import type { SettingBundle } from '../settings/setting-definition.js';

/** Whether a capability only reads or also changes the brand's data (spec 0009, AC-6). */
export const CapabilityKind = z.enum(['read', 'write']);
/** One capability kind. */
export type CapabilityKind = z.infer<typeof CapabilityKind>;

/**
 * What a capability does once its bundle lapses or its module is toggled off (spec 0009, AC-6):
 * `none` stops; `pre_lapse` keeps working through the wind down for records opened before the
 * lapse; `until_closed` keeps working for records opened before the lapse or the toggle off until
 * it reports no open item, also after the wind down.
 */
export const WindDown = z.enum(['none', 'pre_lapse', 'until_closed']);
/** One wind down rule. */
export type WindDown = z.infer<typeof WindDown>;

/**
 * One capability of a module (spec 0009, AC-6, *Module registry*): a slice of a module's work
 * that a route, a job, an executor, or a hook declares, so it can stop on its own. Its `key` is
 * `<module>.<name>`; its `bundle` may differ from its module's. Pure data.
 */
export interface CapabilityDefinition {
  /** `<module key>.<name>`, snake case. */
  readonly key: string;
  /** The bundle whose license it needs; `core` never stops by license. */
  readonly bundle: SettingBundle;
  /** Read or write. */
  readonly kind: CapabilityKind;
  /** What it does at a lapse or a toggle off. */
  readonly windDown: WindDown;
  /**
   * Capability keys of which at least one must be `on` for this one to run (AC-29). An empty list
   * is never satisfied: the capability waits until a feature adds a source. Left out: no rule.
   */
  readonly requiresOneOf?: readonly string[];
  /** The permissions whose holders' work it carries, for the staff notice (AC-17). */
  readonly workOf: readonly Permission[];
  /** Keys of the `executing_step` settings that gate parts of its work (each gates only this one). */
  readonly steps?: readonly string[];
  /** Catalog key of its name, for notices and the settings screen. */
  readonly label: MessageKey;
}

/**
 * One api module (spec 0009, AC-6, *Module registry*): a folder `apps/api/src/<key>/` holding
 * `<key>.module.ts`. A `core` module has no toggle and requires only core modules; a toggleable
 * module's switch is the setting `module.<key>.enabled`. A row lands in the same change as the
 * module's code, never before (wave 1 amendment). Pure data.
 */
export interface ModuleDefinition {
  /** The folder name under `apps/api/src/`, snake case. */
  readonly key: string;
  /** The bundle it is sold in. */
  readonly bundle: SettingBundle;
  /** Whether a holder of `settings.manage` may switch it off; `core` modules never may. */
  readonly toggle: boolean;
  /** Module keys it depends on (turning one of those off is refused while this one is on). */
  readonly requires: readonly string[];
  /** Catalog key of its name. */
  readonly label: MessageKey;
  /** Catalog key of one sentence saying what it holds (the toggle's description). */
  readonly description: MessageKey;
  /** Its capabilities; a route of the module that no capability serves is gated by the module. */
  readonly capabilities: readonly CapabilityDefinition[];
}

/** Declares one module row, freezing it. Use it only in the registry and in test fixtures. */
export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze(definition.capabilities.map((c) => Object.freeze({ ...c }))),
  });
}
