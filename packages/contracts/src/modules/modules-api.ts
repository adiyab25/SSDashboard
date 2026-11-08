import { z } from 'zod';
import { InternalHat, type Hat, type Permission } from '../access.js';
import { LicenseBundle, LicenseDate } from '../license/license-envelope.js';
import { LicenseNotice } from '../license/license-api.js';
import { capabilitiesStoppingAt, noticeWindsDown } from '../license/license-notice-work.js';
import { LICENSE_LAPSE_AFTER_EXPIRY_DAYS } from '../license/license-phase.js';
import type { ModuleDefinition } from './module-definition.js';
import { ModuleStateName, StopReason, type EffectiveState } from './module-state.js';

/** An instant as the modules api sends it, ISO 8601 with an offset. */
const ModuleInstant = z.iso.datetime({ offset: true });

/**
 * One module's or capability's state as `GET /api/platform/modules` answers it (spec 0009,
 * AC-26): `since` for `on` (the instant it last became runnable) and for `read_only` and `off`
 * (when it stopped, when known); `before` for `limited` (only records opened before it can
 * finish); `reason` for every state but `on`. Null where a field does not apply.
 */
export const ModuleStateView = z.object({
  key: z.string(),
  state: ModuleStateName,
  since: ModuleInstant.nullable(),
  before: ModuleInstant.nullable(),
  reason: StopReason.nullable(),
});
/** One state view. */
export type ModuleStateView = z.infer<typeof ModuleStateView>;

/**
 * The view of a state for a caller who wears no internal hat (only `partner` or `media_buyer`):
 * `key` and `state` only, so the plan, its lapse instant, and why something stopped stay with the
 * brand (wave 1 review W8; security review m3, finding 1). Pure.
 */
export function externalModuleStateView(view: ModuleStateView): ModuleStateView {
  return { key: view.key, state: view.state, since: null, before: null, reason: null };
}

/** The view of one effective state under `key`. Pure. */
export function moduleStateView(key: string, state: EffectiveState): ModuleStateView {
  switch (state.state) {
    case 'on':
      return { key, state: 'on', since: state.since, before: null, reason: null };
    case 'limited':
      return { key, state: 'limited', since: null, before: state.before, reason: state.reason };
    case 'read_only':
    case 'off':
      return { key, state: state.state, since: state.since, before: null, reason: state.reason };
  }
}

/**
 * The neutral notice for staff whose work stops at a lapse (spec 0009, AC-17): the bundle, the
 * day and instant it stops, and the capabilities (keys) of the caller's work that stop then. No
 * price and no commercial term; the screen words it ("From 15 April the confirmation queue stops.
 * Ask your manager.").
 */
export const StaffNotice = z.object({
  bundle: LicenseBundle,
  stopsOn: LicenseDate,
  stopsAt: ModuleInstant,
  capabilities: z.array(z.string()).min(1),
});
/** One staff notice. */
export type StaffNotice = z.infer<typeof StaffNotice>;

/** From this many days before the lapse, staff whose work stops see the notice (AC-17). */
export const STAFF_NOTICE_DAYS = 7;

/**
 * The staff notices for a caller (spec 0009, AC-17): for each bundle whose manager notice shows a
 * lapse within `STAFF_NOTICE_DAYS` days, or a wind down under way, the capabilities that stop at
 * that lapse (`capabilitiesStoppingAt`, the rule the manager's day notice uses too) whose `workOf`
 * names a permission the caller holds. A caller who wears no internal hat (only `partner` or `media_buyer`) gets none (wave 1
 * review W8). Pure.
 */
export function staffNotices(
  modules: readonly ModuleDefinition[],
  notices: readonly LicenseNotice[],
  caller: { readonly hats: readonly Hat[]; readonly permissions: readonly Permission[] },
): StaffNotice[] {
  if (!caller.hats.some((hat) => InternalHat.safeParse(hat).success)) return [];
  const held = new Set<Permission>(caller.permissions);
  const found: StaffNotice[] = [];
  for (const notice of notices) {
    const daysToLapse = notice.daysLeft + LICENSE_LAPSE_AFTER_EXPIRY_DAYS;
    const soon =
      (notice.phase === 'expiring' || notice.phase === 'grace') && daysToLapse <= STAFF_NOTICE_DAYS;
    if (!soon && notice.phase !== 'wind_down') continue;
    const windsDown = noticeWindsDown(notice);
    const workOf = new Map(
      modules.flatMap((module) => module.capabilities).map((c) => [c.key, c.workOf] as const),
    );
    const stopping = capabilitiesStoppingAt(modules, notice.bundle, windsDown).filter((key) =>
      (workOf.get(key) ?? []).some((permission) => held.has(permission)),
    );
    if (stopping.length > 0) {
      found.push({
        bundle: notice.bundle,
        stopsOn: notice.lapsesOn,
        stopsAt: notice.lapsesAt,
        capabilities: stopping,
      });
    }
  }
  return found;
}

/**
 * `GET /api/platform/modules` (spec 0009, AC-26), readable by every staff hat: every module's and
 * capability's state in registry order (a module's own state is never `limited`; for a caller
 * with no internal hat only `key` and `state`, the other fields null), the caller's staff notices
 * (AC-17), and, for a holder of `settings.manage` only, the manager's license notices (null for
 * anyone else). The shell hides entries by it (AC-9).
 */
export const ModuleStatesResponse = z.object({
  modules: z.array(ModuleStateView),
  capabilities: z.array(ModuleStateView),
  staffNotices: z.array(StaffNotice),
  licenseNotices: z.array(LicenseNotice).nullable(),
});
/** The modules answer. */
export type ModuleStatesResponse = z.infer<typeof ModuleStatesResponse>;

/**
 * The stable codes of the module gate and of a module's own refusals (spec 0009, AC-8, AC-12,
 * AC-30): 404 `MODULE_OFF` (a route of an `off` module or capability, or a write of a `read_only`
 * one), 409 `MODULE_LIMITED` with `before` (a `limited` capability refuses a record opened at or
 * after it), 409 `MODULE_REQUIRED_BY` with `dependants` (turning off a module another `on` module
 * requires), 409 `MODULE_REQUIRES` with `requires` (turning on a module while a module it
 * requires is not `on`), and 503 `OFF_IMPACT_UNAVAILABLE` (a capability could not say what turning
 * it off drops; try again).
 */
export const ModuleErrorCode = z.enum([
  'MODULE_OFF',
  'MODULE_LIMITED',
  'MODULE_REQUIRED_BY',
  'MODULE_REQUIRES',
  'OFF_IMPACT_UNAVAILABLE',
]);
/** One module error code. */
export type ModuleErrorCode = z.infer<typeof ModuleErrorCode>;

/** The body of a 409 `MODULE_LIMITED` answer. */
export const ModuleLimitedError = z.object({
  code: z.literal('MODULE_LIMITED'),
  message: z.string(),
  before: ModuleInstant,
});
/** A `MODULE_LIMITED` body. */
export type ModuleLimitedError = z.infer<typeof ModuleLimitedError>;

/** The body of a 409 `MODULE_REQUIRED_BY` answer: the `on` modules that require this one. */
export const ModuleRequiredByError = z.object({
  code: z.literal('MODULE_REQUIRED_BY'),
  message: z.string(),
  dependants: z.array(z.string()).min(1),
});
/** A `MODULE_REQUIRED_BY` body. */
export type ModuleRequiredByError = z.infer<typeof ModuleRequiredByError>;

/** The body of a 409 `MODULE_REQUIRES` answer: the required modules that are not `on`. */
export const ModuleRequiresError = z.object({
  code: z.literal('MODULE_REQUIRES'),
  message: z.string(),
  requires: z.array(z.string()).min(1),
});
/** A `MODULE_REQUIRES` body. */
export type ModuleRequiresError = z.infer<typeof ModuleRequiresError>;
