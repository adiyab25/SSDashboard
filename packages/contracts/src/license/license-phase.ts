import { z } from 'zod';
import type { LicenseBundle } from './license-envelope.js';

/**
 * Where a bundle stands (spec 0009, AC-15, *Bundle phases*); the twin of the database enum
 * `license_phase`. `expiring` and `grace` behave as `active`; Warehouse never takes `wind_down`.
 */
export const LicensePhase = z.enum([
  'not_licensed',
  'active',
  'expiring',
  'grace',
  'wind_down',
  'off',
]);
/** One bundle phase. */
export type LicensePhase = z.infer<typeof LicensePhase>;

/** From this many days before expiry (expiry day included, as 0) a bundle is `expiring`. */
export const LICENSE_EXPIRING_DAYS = 30;
/** Days after expiry that are `grace` (expiry plus 1 to expiry plus 14). */
export const LICENSE_GRACE_DAYS = 14;
/** The lapse day is expiry plus this many days; the lapse instant is local 00:00 that day. */
export const LICENSE_LAPSE_AFTER_EXPIRY_DAYS = LICENSE_GRACE_DAYS + 1;

/** The terms of one recorded license that the phase reads (a `licenses` row). */
export interface RecordedLicenseTerms {
  readonly bundles: readonly LicenseBundle[];
  readonly operationsExpiresOn: string | null;
  readonly warehouseExpiresOn: string | null;
}

/** What the recorded licenses grant one bundle, by the union rule of AC-20. */
export interface BundleEntitlement {
  /** Some recorded license grants the bundle. */
  readonly licensed: boolean;
  /** Some recorded license grants it with no expiry (Warehouse only). */
  readonly perpetual: boolean;
  /** The latest expiry across the recorded licenses, null when not licensed or perpetual. */
  readonly expiresOn: string | null;
}

/**
 * The entitlement of one bundle from every recorded license (spec 0009, AC-20, the union rule): a
 * Warehouse grant with no expiry never expires; otherwise the latest expiry counts. Operations is
 * always a yearly plan, so an Operations grant without an expiry (refused by the payload schema
 * and the table check) is ignored, never read as perpetual (review M2 code 14). Recorded licenses
 * only add, so a new license never shortens an expiry or removes a bundle. Pure.
 */
export function bundleEntitlement(
  bundle: LicenseBundle,
  licenses: readonly RecordedLicenseTerms[],
): BundleEntitlement {
  const expiries = licenses
    .filter((license) => license.bundles.includes(bundle))
    .map((license) =>
      bundle === 'operations' ? license.operationsExpiresOn : license.warehouseExpiresOn,
    )
    .filter((expiry) => bundle === 'warehouse' || expiry !== null);
  if (expiries.length === 0) return { licensed: false, perpetual: false, expiresOn: null };
  if (expiries.some((expiry) => expiry === null)) {
    return { licensed: true, perpetual: true, expiresOn: null };
  }
  const latest = (expiries as string[]).reduce((max, day) => (day > max ? day : max));
  return { licensed: true, perpetual: false, expiresOn: latest };
}

/** The Operations wind down facts the phase needs (spec 0009, AC-15, AC-18). */
export interface WindDownInput {
  /** Setting `operations_wind_down_days`: the longest the wind down lasts. */
  readonly days: number;
  /** Setting `operations_wind_down_pickup_days`: the early end never comes before this window. */
  readonly pickupDays: number;
  /**
   * Open items of every `pre_lapse` capability, or null while no `pre_lapse` capability is
   * registered: then the wind down ends only by its length, never early (review M2 code 3).
   * Milestone 4 passes the sum of the registered capabilities' `openItems`.
   */
  readonly openPreLapseItems: number | null;
  /**
   * The local date the wind down was recorded as ended (`license_checks.wind_down_ended_at`), or
   * null. It counts only from the current lapse day to today: a renewal moves the lapse and starts
   * afresh, and an end recorded while the clock was set ahead is ignored once it is back, so a
   * wrong clock never switches Operations off for good (owner ruling 2). It can only restrict.
   */
  readonly endedOn: string | null;
}

/** What `bundlePhase` reads (spec 0009, *Value sourcing*). */
export interface BundlePhaseInput {
  /** Today, the local date in the `timezone` setting (`YYYY-MM-DD`). */
  readonly today: string;
  /** Every recorded license. */
  readonly licenses: readonly RecordedLicenseTerms[];
  /** Read for Operations only. */
  readonly windDown: WindDownInput;
}

/** One bundle's phase with the dates the screen and the notices show. */
export interface BundleStanding {
  readonly bundle: LicenseBundle;
  readonly phase: LicensePhase;
  readonly perpetual: boolean;
  readonly expiresOn: string | null;
  /** Days from today to the expiry day (0 on it, negative after it); null without an expiry. */
  readonly daysLeft: number | null;
  /** The lapse day, expiry plus 15; null without an expiry. */
  readonly lapsesOn: string | null;
  /** Operations only: the last day the wind down can last until (lapse plus its length). */
  readonly windDownEndsOn: string | null;
}

/** Days since 1970-01-01 of a `YYYY-MM-DD` date. */
function dayNumber(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** The date `days` days after `date` (before it when negative). Pure. */
export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). Pure. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * One bundle's phase and dates (spec 0009, AC-15, *Bundle phases*), from the recorded licenses,
 * today's local date and, for Operations, the wind down facts. More than 30 days before expiry is
 * `active`; 30 to 0 days (expiry day included) `expiring`; expiry plus 1 to plus 14 `grace`; from
 * the lapse day (expiry plus 15): Warehouse `off`, Operations `wind_down` until its length has
 * passed, or earlier once the pickup window has passed with no open `pre_lapse` item (never while
 * no `pre_lapse` capability is registered), then `off`. A recorded end of the wind down between
 * the current lapse and today keeps `off` until a renewal moves the lapse. Pure; it never reads a
 * clock.
 */
export function bundleStanding(bundle: LicenseBundle, input: BundlePhaseInput): BundleStanding {
  const entitlement = bundleEntitlement(bundle, input.licenses);
  const none = { bundle, perpetual: false, expiresOn: null, daysLeft: null, lapsesOn: null };
  if (!entitlement.licensed) return { ...none, phase: 'not_licensed', windDownEndsOn: null };
  if (entitlement.perpetual || entitlement.expiresOn === null) {
    return { ...none, phase: 'active', perpetual: true, windDownEndsOn: null };
  }
  const expiresOn = entitlement.expiresOn;
  const daysLeft = daysBetween(input.today, expiresOn);
  const lapsesOn = addDays(expiresOn, LICENSE_LAPSE_AFTER_EXPIRY_DAYS);
  const windDownEndsOn = bundle === 'operations' ? addDays(lapsesOn, input.windDown.days) : null;
  const dated = { bundle, perpetual: false, expiresOn, daysLeft, lapsesOn, windDownEndsOn };
  if (daysLeft > LICENSE_EXPIRING_DAYS) return { ...dated, phase: 'active' };
  if (daysLeft >= 0) return { ...dated, phase: 'expiring' };
  if (daysLeft >= -LICENSE_GRACE_DAYS) return { ...dated, phase: 'grace' };
  if (bundle === 'warehouse') return { ...dated, phase: 'off' };

  const { days, pickupDays, openPreLapseItems, endedOn } = input.windDown;
  const sinceLapse = daysBetween(lapsesOn, input.today);
  const ended = endedOn !== null && endedOn >= lapsesOn && endedOn <= input.today;
  const earlyEnd = openPreLapseItems === 0 && sinceLapse >= pickupDays;
  if (ended || sinceLapse >= days || earlyEnd) {
    return { ...dated, phase: 'off' };
  }
  return { ...dated, phase: 'wind_down' };
}

/** One bundle's phase (spec 0009, AC-15): `bundleStanding(bundle, input).phase`. Pure. */
export function bundlePhase(bundle: LicenseBundle, input: BundlePhaseInput): LicensePhase {
  return bundleStanding(bundle, input).phase;
}

/**
 * Whether a bundle in this phase counts as licensed now (spec 0009, *Effective state*): `active`,
 * `expiring`, and `grace`. `core` is licensed always and is never asked here.
 */
export function isLicensedNow(phase: LicensePhase): boolean {
  return phase === 'active' || phase === 'expiring' || phase === 'grace';
}
