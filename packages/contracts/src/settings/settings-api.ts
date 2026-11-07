import { z } from 'zod';
import { SettingBundle, SettingGroup, SettingReasonRule } from './setting-definition.js';

/** The deepest nesting a setting value may have (security review S3). */
export const SETTING_VALUE_MAX_DEPTH = 16;

/**
 * Whether a value nests arrays or objects deeper than `maxDepth` (a scalar is depth 0). Walks
 * with an explicit stack, never recursion, so a hostile 10,000 level body cannot overflow it.
 * Pure; never throws.
 */
export function nestsDeeperThan(value: unknown, maxDepth: number): boolean {
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (node === null || typeof node !== 'object') continue;
    if (depth + 1 > maxDepth) return true;
    for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

/** A JSON value as a setting stores it. */
export const SettingJson = z.json();

/**
 * A setting value in a request: refused when nested deeper than `SETTING_VALUE_MAX_DEPTH` before
 * the recursive JSON check runs (a pipe stops at the first failure), then any JSON value.
 */
export const SettingJsonInput = z
  .unknown()
  .refine(
    (value) => !nestsDeeperThan(value, SETTING_VALUE_MAX_DEPTH),
    `A setting value may nest at most ${SETTING_VALUE_MAX_DEPTH} levels`,
  )
  .pipe(SettingJson);
/** The validated shape of `SettingJson`, as the api and web see it after parsing. */
export type SettingJson = z.infer<typeof SettingJson>;

/**
 * An instant as the settings api sends it: ISO 8601 in UTC with microseconds
 * (`2026-11-07T10:15:30.123456Z`), the full precision of `settings.updated_at`, so a client can
 * send it back as `expectedUpdatedAt` and match the row exactly.
 */
export const SettingInstant = z.iso.datetime({ offset: true });

/**
 * One entry of `GET /api/settings` and of the `PUT` answer (spec 0009, AC-26): the registry facts
 * the screen needs plus the value in force. `value` is the stored value, or the default when
 * there is no row or the row fails its schema (`invalid: true`). `isDefault` is true when the
 * value in force equals the default. `updatedAt` is null while the key has no row; send it back
 * unchanged as `expectedUpdatedAt`. `label`, `description`, and `warning` are `@ssdashboard/i18n`
 * keys. `canChange` says whether the caller may change it (false for `whoMayChange: nobody`);
 * `licensed` says whether the entry's bundle is licensed. They are kept apart so the screen can
 * say why: the web disables an entry when either is false, showing "needs the Warehouse plan" or
 * "needs the Operations plan" for `licensed: false` (AC-25). The api refuses a write of an
 * unlicensed entry with 409 `NOT_LICENSED` (security review S6, decided in milestone 2).
 */
export const SettingEntryView = z.object({
  key: z.string(),
  group: SettingGroup,
  bundle: SettingBundle,
  label: z.string(),
  description: z.string(),
  warning: z.string().nullable(),
  confirm: z.literal('typed').nullable(),
  reason: SettingReasonRule,
  value: SettingJson,
  default: SettingJson,
  isDefault: z.boolean(),
  invalid: z.boolean(),
  updatedAt: SettingInstant.nullable(),
  updatedBy: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
  canChange: z.boolean(),
  licensed: z.boolean(),
});
/** The validated shape of `SettingEntryView`, as the api and web see it after parsing. */
export type SettingEntryView = z.infer<typeof SettingEntryView>;

/** Answer of `GET /api/settings`: every registry entry, in screen order. */
export const SettingsListResponse = z.object({ entries: z.array(SettingEntryView) });
/** The validated shape of `SettingsListResponse`, as the api and web see it after parsing. */
export type SettingsListResponse = z.infer<typeof SettingsListResponse>;

/**
 * Body of `PUT /api/settings/:key` (spec 0009, AC-3). `value` is checked against the entry's own
 * schema by the api (422 `SETTING_INVALID`, also for a value nested deeper than 16 levels, and
 * for a value that breaks a rule across settings, `settingWriteIssues`); `reason` is trimmed and required where the entry says so (422
 * `REASON_REQUIRED`), at most 500 characters; `expectedUpdatedAt` is the `updatedAt` the screen
 * showed, null when the key had no row (409 `STALE_SETTING` when it differs).
 */
export const PutSettingBody = z.object({
  value: SettingJsonInput,
  reason: z.string().trim().max(500).optional(),
  expectedUpdatedAt: SettingInstant.nullable(),
});
/** The validated shape of `PutSettingBody`, as the api and web see it after parsing. */
export type PutSettingBody = z.infer<typeof PutSettingBody>;

/**
 * Answer of `PUT /api/settings/:key`: the entry as it now stands and whether anything was
 * written. `changed: false` means the value equalled the one in force: no row, audit entry, or
 * notification was written, and `updatedAt` did not move.
 */
export const PutSettingAnswer = z.object({ entry: SettingEntryView, changed: z.boolean() });
/** The validated shape of `PutSettingAnswer`, as the api and web see it after parsing. */
export type PutSettingAnswer = z.infer<typeof PutSettingAnswer>;

/**
 * The stable error codes of the settings routes (spec 0009, AC-3): 404 `SETTING_UNKNOWN`, 422
 * `SETTING_INVALID` (with `issues`), 422 `REASON_REQUIRED`, 422 `REASON_TOO_LONG`, 409
 * `STALE_SETTING`, 409 `SETTING_LOCKED`, 409 `NOT_LICENSED` (the entry's bundle is not licensed
 * now: core always is; Warehouse or Operations while its phase is active, expiring, or grace;
 * security finding S6), and the guard's 403 `FORBIDDEN`. A malformed body is 422
 * `VALIDATION_FAILED`.
 */
export const SettingErrorCode = z.enum([
  'SETTING_UNKNOWN',
  'SETTING_INVALID',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'STALE_SETTING',
  'SETTING_LOCKED',
  'NOT_LICENSED',
  'FORBIDDEN',
  'VALIDATION_FAILED',
]);
/** The validated shape of `SettingErrorCode`, as the api and web see it after parsing. */
export type SettingErrorCode = z.infer<typeof SettingErrorCode>;
