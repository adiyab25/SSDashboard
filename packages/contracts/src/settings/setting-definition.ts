import type { MessageKey } from '@ssdashboard/i18n';
import { z } from 'zod';

/** The bundle a setting belongs to (spec 0009, AC-1); `core` is on every install. */
export const SettingBundle = z.enum(['core', 'warehouse', 'operations']);
/** The validated shape of `SettingBundle`, as the api and web see it after parsing. */
export type SettingBundle = z.infer<typeof SettingBundle>;

/** The settings screen section an entry shows in (spec 0009, AC-25). */
export const SettingGroup = z.enum(['brand', 'modules', 'automations', 'policies']);
/** The validated shape of `SettingGroup`, as the api and web see it after parsing. */
export type SettingGroup = z.infer<typeof SettingGroup>;

/**
 * Whether a change needs a typed reason. Passed to `AuditService.record` as the tightening flag
 * of spec 0010 AC-5, so it can make a reason required, never optional where the audit code
 * requires one.
 */
export const SettingReasonRule = z.enum(['required', 'optional']);
/** The validated shape of `SettingReasonRule`, as the api and web see it after parsing. */
export type SettingReasonRule = z.infer<typeof SettingReasonRule>;

/**
 * Who reads a setting: `public_config` entries are served to everyone by `GET /api/config`;
 * `staff` entries only to holders of `settings.manage` (spec 0009, AC-5, AC-26).
 */
export const SettingExposure = z.enum(['public_config', 'staff']);
/** The validated shape of `SettingExposure`, as the api and web see it after parsing. */
export type SettingExposure = z.infer<typeof SettingExposure>;

/** Who may change a setting: holders of the spec 0008 permission, or nobody in the app. */
export const SettingChanger = z.enum(['settings.manage', 'nobody']);
/** The validated shape of `SettingChanger`, as the api and web see it after parsing. */
export type SettingChanger = z.infer<typeof SettingChanger>;

/**
 * What a business read does with a stored row that fails its schema: `default` reads the registry
 * default (the row is still flagged `invalid` in the staff read and logged once); `refuse` throws
 * `SettingUnreadable` instead, for settings that guard the ledger or money, so a corrupt row
 * stops the work rather than loosening a rule (security review S1). The staff read always shows
 * the default with `invalid: true`, so a manager can see and fix the row.
 */
export const SettingInvalidRule = z.enum(['default', 'refuse']);
/** The validated shape of `SettingInvalidRule`, as the api and web see it after parsing. */
export type SettingInvalidRule = z.infer<typeof SettingInvalidRule>;

/** The kind of entry: an ordinary value, or an executing step switch (spec 0009, AC-21). */
export type SettingKind = 'value' | 'executing_step';

/**
 * One brand setting in the registry (spec 0009, AC-1). The schema validates every stored and
 * written value; `default` is what a missing row means. Labels and warnings are
 * `@ssdashboard/i18n` keys, never display text. Pure data: it never touches a database.
 */
export interface SettingDefinition<K extends string = string, S extends z.ZodType = z.ZodType> {
  /** The `settings.key` of the row; `snake_case`. */
  readonly key: K;
  /** Validates the value on every read and write. */
  readonly schema: S;
  /** The value of a key with no row. It must pass `schema` (`registry.spec.ts`). */
  readonly default: z.output<S>;
  /** The bundle whose license the entry needs. */
  readonly bundle: SettingBundle;
  /** The settings screen section. */
  readonly group: SettingGroup;
  /** Who may change it; `nobody` answers 409 `SETTING_LOCKED`. */
  readonly whoMayChange: SettingChanger;
  /** Whether a change needs a typed reason. */
  readonly reason: SettingReasonRule;
  /** Whether `GET /api/config` serves it. */
  readonly exposure: SettingExposure;
  /** True when SQL reads the row (for example `ssd_operating_day`), so a seed row must exist. */
  readonly sqlRead: boolean;
  /** Ordinary value or executing step. */
  readonly kind: SettingKind;
  /** What a business read does with an invalid stored row; `default` when left out. */
  readonly onInvalid?: SettingInvalidRule;
  /** Catalog key of the entry's name on the settings screen. */
  readonly label: MessageKey;
  /** Catalog key of one sentence saying what the setting does. */
  readonly description: MessageKey;
  /** Catalog key of what else the change moves, shown in the change dialog. */
  readonly warning?: MessageKey;
  /** `typed`: the change dialog asks the person to type the setting's name. */
  readonly confirm?: 'typed';
  /** Executing steps only: whether the customer hears about what the step does (AC-21). */
  readonly notifiesCustomer?: boolean;
}

/**
 * Declares one registry entry, checking at compile time that `default` has the schema's output
 * type and keeping the key as a literal, so `SettingsService.get('timezone')` is typed. Freezes
 * the entry; never use it outside the registry files.
 */
export function defineSetting<const K extends string, S extends z.ZodType>(
  definition: SettingDefinition<K, S>,
): SettingDefinition<K, S> {
  return Object.freeze(definition);
}
