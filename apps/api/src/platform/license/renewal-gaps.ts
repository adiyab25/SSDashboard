import {
  addDays,
  bundleEntitlement,
  LICENSE_LAPSE_AFTER_EXPIRY_DAYS,
  LicenseBundle,
  type LicensePhase,
  type RecordedLicenseTerms,
} from '@ssdashboard/contracts';

/**
 * How long after a renewal the supervisor still backfills its gap (spec 0009, AC-19). The
 * `platform.backfill` queue keeps finished jobs 90 days (`BACKFILL_KEEP_SECONDS`), longer than this
 * window, so a job is always found by its key and never sent twice inside the window; the window only keeps a capability that lands
 * long after a renewal from catching up a gap from before its time. A worker down longer than this
 * after a renewal does not backfill it.
 */
export const RENEWAL_BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** One license check as the renewal rule reads it, in `seq` order. */
export interface CheckPhases {
  /** `license_checks.seq` as text. */
  readonly seq: string;
  /** When it ran, as an ISO instant. */
  readonly checkedAt: string;
  readonly operations: LicensePhase;
  readonly warehouse: LicensePhase;
}

/** One recorded license that verifies, with the `seq` of the `valid` check that recorded it. */
export interface RecordedLicense {
  readonly terms: RecordedLicenseTerms;
  readonly recordedSeq: string;
}

/**
 * A renewal out of the wind down or `off`: the bundle, the renewing check (its `seq`, which keys
 * the backfill job, and its instant, the gap's end), and the lapse day it renewed from (local
 * 00:00 of that day is the gap's start).
 */
export interface Renewal {
  readonly bundle: LicenseBundle;
  readonly seq: string;
  readonly at: string;
  readonly lapsesOn: string;
}

const LAPSED: ReadonlySet<LicensePhase> = new Set(['wind_down', 'off']);
const LICENSED: ReadonlySet<LicensePhase> = new Set(['active', 'expiring', 'grace']);

/**
 * The renewals in `checks` younger than `windowMs` at `now` (spec 0009, AC-19): every check whose
 * bundle phase moved from `wind_down` or `off` to `active`, `expiring`, or `grace` (a move out of
 * `grace` stopped nothing, so it is no renewal). The lapse day it renewed from comes from the
 * licenses recorded before that check; a move without a lapse behind it (a clock set back, so the
 * old lapse day is after the renewal's local day) is no renewal either. `localDay` gives an
 * instant's local date in the install time zone. Pure.
 */
export function renewalsOf(
  checks: readonly CheckPhases[],
  licenses: readonly RecordedLicense[],
  options: { now: number; windowMs: number; localDay: (instant: string) => string },
): Renewal[] {
  const renewals: Renewal[] = [];
  for (const bundle of LicenseBundle.options) {
    for (let i = 1; i < checks.length; i += 1) {
      const prior = checks[i - 1] as CheckPhases;
      const check = checks[i] as CheckPhases;
      if (!LAPSED.has(prior[bundle]) || !LICENSED.has(check[bundle])) continue;
      if (Date.parse(check.checkedAt) <= options.now - options.windowMs) continue;
      const before = licenses.filter((l) => BigInt(l.recordedSeq) < BigInt(check.seq));
      const old = bundleEntitlement(
        bundle,
        before.map((l) => l.terms),
      );
      if (!old.licensed || old.perpetual || old.expiresOn === null) continue;
      const lapsesOn = addDays(old.expiresOn, LICENSE_LAPSE_AFTER_EXPIRY_DAYS);
      if (lapsesOn > options.localDay(check.checkedAt)) continue;
      renewals.push({ bundle, seq: check.seq, at: check.checkedAt, lapsesOn });
    }
  }
  return renewals;
}
