import { z } from 'zod';
import type { ModuleDefinition } from '../modules/module-definition.js';
import { LicenseDate, type LicenseBundle } from './license-envelope.js';
import { LicenseNotice } from './license-api.js';

/**
 * The days before expiry on which the daily report's automation status line carries the manager
 * notice (spec 0009, AC-17); it also carries it on every grace and wind down day.
 */
export const LICENSE_REPORT_DAYS: readonly number[] = Object.freeze([30, 14, 7]);

/**
 * Whether the daily report (feature 25) carries this manager notice today (spec 0009, AC-17): on
 * days 30, 14, and 7 before expiry, and on every grace and wind down day. Never on an `off` day:
 * the wind down's last reduced report has said what is still open. Pure.
 */
export function noticeInDailyReport(notice: LicenseNotice): boolean {
  switch (notice.phase) {
    case 'expiring':
      return LICENSE_REPORT_DAYS.includes(notice.daysLeft);
    case 'grace':
    case 'wind_down':
      return true;
    case 'off':
    case 'active':
    case 'not_licensed':
      return false;
  }
}

/**
 * Work that keeps going after a lapse (spec 0009, AC-17, AC-18): a `pre_lapse` capability until
 * the wind down ends (`untilOn`, the wind down's last day), or an `until_closed` one until its open
 * items reach zero (`untilOn` null: no fixed day).
 */
export const ContinuingWork = z.object({
  capability: z.string(),
  until: z.enum(['wind_down_end', 'open_items_closed']),
  untilOn: LicenseDate.nullable(),
});
/** One piece of continuing work. */
export type ContinuingWork = z.infer<typeof ContinuingWork>;

/**
 * `LicenseService.notice(day)` (spec 0009, AC-17, task 22): the manager notice of one bundle on a
 * day, plus whether the daily report carries it that day (`inReport`), the capabilities that stop
 * at the lapse instant (`stops`, keys), and what continues and until when (`continues`). Codes,
 * keys, and dates only: the screen and the report word them in both languages. Never a price or a
 * commercial term. Every field of `LicenseNotice` is here, so it is one wherever one is read.
 */
export const LicenseDayNotice = LicenseNotice.extend({
  inReport: z.boolean(),
  stops: z.array(z.string()),
  continues: z.array(ContinuingWork),
});
/** One day notice. */
export type LicenseDayNotice = z.infer<typeof LicenseDayNotice>;

/**
 * The capabilities that stop at a bundle's lapse instant (spec 0009, AC-17, AC-18), in registry
 * order: the one rule the manager's day notice (`licenseNoticeWork`) and the staff notice
 * (`staffNotices`) share. A capability of the bundle stops when its `windDown` is `none`, or
 * `pre_lapse` when the bundle has no wind down (Warehouse, or a notice without a wind down day;
 * *Effective state* rule 3). A capability of another bundle stops too when it has a non empty
 * `requiresOneOf` whose every source is in the lapsing bundle (rule 6: a lapsed source is never
 * `on`), such as the Shopify stock push whose only source is the Bosta mirror. Pure.
 */
export function capabilitiesStoppingAt(
  modules: readonly ModuleDefinition[],
  bundle: LicenseBundle,
  windsDown: boolean,
): string[] {
  const capabilities = modules.flatMap((module) => module.capabilities);
  const bundleOf = new Map(capabilities.map((capability) => [capability.key, capability.bundle]));
  return capabilities
    .filter((capability) => {
      if (capability.bundle === bundle) {
        return (
          capability.windDown === 'none' || (capability.windDown === 'pre_lapse' && !windsDown)
        );
      }
      const sources = capability.requiresOneOf ?? [];
      return sources.length > 0 && sources.every((source) => bundleOf.get(source) === bundle);
    })
    .map((capability) => capability.key);
}

/**
 * Whether a notice's `pre_lapse` work still runs, or will run, through a wind down: only an
 * Operations notice with a wind down day whose phase is not yet `off`. Once the wind down has
 * ended (early, or by its length), `windDownEndsOn` still names the day it could have lasted
 * until, but nothing continues until it. Pure.
 */
export function noticeWindsDown(
  notice: Pick<LicenseNotice, 'bundle' | 'windDownEndsOn' | 'phase'>,
): boolean {
  return notice.bundle === 'operations' && notice.windDownEndsOn !== null && notice.phase !== 'off';
}

/**
 * What stops and what continues at a bundle's lapse (spec 0009, AC-17, AC-18), from the module
 * registry: what stops is `capabilitiesStoppingAt`; Operations `pre_lapse` work continues until
 * the wind down ends, but only while it has not ended (`noticeWindsDown`): in `off` it is under
 * `stops`; `until_closed` work continues until its open items close, also in `off` (W1). A notice
 * without a wind down day (Warehouse) winds nothing down, so its `pre_lapse` work stops. Pure; the
 * web may call it with `MODULE_REGISTRY` to word the banner.
 */
export function licenseNoticeWork(
  modules: readonly ModuleDefinition[],
  notice: Pick<LicenseNotice, 'bundle' | 'windDownEndsOn' | 'phase'>,
): { stops: string[]; continues: ContinuingWork[] } {
  const windsDown = noticeWindsDown(notice);
  const continues: ContinuingWork[] = [];
  for (const capability of modules.flatMap((module) => module.capabilities)) {
    if (capability.bundle !== notice.bundle) continue;
    if (capability.windDown === 'until_closed') {
      continues.push({ capability: capability.key, until: 'open_items_closed', untilOn: null });
    } else if (capability.windDown === 'pre_lapse' && windsDown) {
      continues.push({
        capability: capability.key,
        until: 'wind_down_end',
        untilOn: notice.windDownEndsOn,
      });
    }
  }
  return { stops: capabilitiesStoppingAt(modules, notice.bundle, windsDown), continues };
}

/** A manager notice with its report flag and its stopping and continuing work. Pure. */
export function licenseDayNotice(
  modules: readonly ModuleDefinition[],
  notice: LicenseNotice,
): LicenseDayNotice {
  return {
    ...notice,
    inReport: noticeInDailyReport(notice),
    ...licenseNoticeWork(modules, notice),
  };
}
