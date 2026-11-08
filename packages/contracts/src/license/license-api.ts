import { z } from 'zod';
import { LicenseBundle, LicenseDate } from './license-envelope.js';
import { LicensePhase, type BundleStanding } from './license-phase.js';

/** How a license reached the install; the twin of the database enum `license_source`. */
export const LicenseSource = z.enum(['file', 'upload']);
/** One license source. */
export type LicenseSource = z.infer<typeof LicenseSource>;

/** What started a check (spec 0009, AC-14); the twin of the database enum `license_check_trigger`. */
export const LicenseCheckTrigger = z.enum(['api_start', 'worker_start', 'daily', 'upload']);
/** One check trigger. */
export type LicenseCheckTrigger = z.infer<typeof LicenseCheckTrigger>;

/**
 * What a check found (spec 0009, AC-16); the twin of the database enum `license_check_outcome`.
 * `valid`: a license verified and was recorded now; `already_recorded`: it verified and was
 * recorded before. Every other outcome changes nothing: recorded licenses keep counting.
 */
export const LicenseCheckOutcome = z.enum([
  'valid',
  'already_recorded',
  'none_configured',
  'file_missing',
  'file_unreadable',
  'bad_format',
  'bad_signature',
  'unknown_key',
  'dev_key_in_production',
  'wrong_install',
]);
/** One check outcome. */
export type LicenseCheckOutcome = z.infer<typeof LicenseCheckOutcome>;

/** The outcomes of a license that verified; the rest are problems the manager's banner names. */
const VERIFIED_OUTCOMES: ReadonlySet<LicenseCheckOutcome> = new Set(['valid', 'already_recorded']);

/** Whether a check outcome is a problem worth a banner (AC-16): anything but a verified license. */
export function isLicenseCheckProblem(outcome: LicenseCheckOutcome): boolean {
  return !VERIFIED_OUTCOMES.has(outcome);
}

/** An instant as the license api sends it, ISO 8601 with an offset. */
const LicenseInstant = z.iso.datetime({ offset: true });

/**
 * How loud a license notice is (spec 0009, AC-17): `info` while expiring with more than 7 days to
 * expiry, `warning` in the last 7 days before expiry and through grace, `critical` from the lapse
 * (wind down or off). Whether the daily report carries a notice is `noticeInDailyReport`, and the
 * staff notice is `staffNotices` (`modules-api.ts`).
 */
export const LicenseNoticeLevel = z.enum(['info', 'warning', 'critical']);
/** One notice level. */
export type LicenseNoticeLevel = z.infer<typeof LicenseNoticeLevel>;

/** From this many days before expiry a notice turns from `info` to `warning`. */
export const LICENSE_WARNING_DAYS = 7;

/**
 * The level of a bundle's notice, or null when the manager needs none (`active`, `not_licensed`,
 * or perpetual). Pure; the api and the web agree through it.
 */
export function licenseNoticeLevel(standing: BundleStanding): LicenseNoticeLevel | null {
  switch (standing.phase) {
    case 'not_licensed':
    case 'active':
      return null;
    case 'expiring':
      return (standing.daysLeft ?? 0) > LICENSE_WARNING_DAYS ? 'info' : 'warning';
    case 'grace':
      return 'warning';
    case 'wind_down':
    case 'off':
      return 'critical';
  }
}

/**
 * The manager's notice for one bundle with an expiry (spec 0009, AC-17), from 30 days before the
 * expiry through grace, the wind down, and off: the phase, the days left, the level, when work
 * stops (`lapsesAt`, local 00:00 of the lapse day) and, for Operations, until when the cash of
 * shipments already out is still followed (`windDownEndsOn`). Codes and dates only; the screen
 * words them in both languages. Never carries a price or a commercial term.
 */
export const LicenseNotice = z.object({
  bundle: LicenseBundle,
  phase: LicensePhase,
  level: LicenseNoticeLevel,
  expiresOn: LicenseDate,
  daysLeft: z.int(),
  lapsesOn: LicenseDate,
  lapsesAt: LicenseInstant,
  windDownEndsOn: LicenseDate.nullable(),
});
/** One license notice. */
export type LicenseNotice = z.infer<typeof LicenseNotice>;

/** One bundle in the license summary: its phase, and its expiry or that it never expires. */
export const LicenseBundleView = z.object({
  bundle: LicenseBundle,
  phase: LicensePhase,
  perpetual: z.boolean(),
  expiresOn: LicenseDate.nullable(),
  daysLeft: z.int().nullable(),
  lapsesAt: LicenseInstant.nullable(),
});
/** One bundle view. */
export type LicenseBundleView = z.infer<typeof LicenseBundleView>;

/**
 * The latest check of the license file (api start, worker start, or the daily check; an upload
 * answers for itself): its outcome and whether the server clock was more than a day behind the
 * latest earlier check (`clockBehind`, recorded and shown, never enforced).
 */
export const LicenseCheckView = z.object({
  checkedAt: LicenseInstant,
  trigger: LicenseCheckTrigger,
  outcome: LicenseCheckOutcome,
  clockBehind: z.boolean(),
});
/** One check view. */
export type LicenseCheckView = z.infer<typeof LicenseCheckView>;

/** One recorded license, never its signature, envelope, or file path. */
export const RecordedLicenseView = z.object({
  id: z.uuid(),
  licenseId: z.string(),
  bundles: z.array(LicenseBundle),
  operationsExpiresOn: LicenseDate.nullable(),
  warehouseExpiresOn: LicenseDate.nullable(),
  issuedOn: LicenseDate,
  source: LicenseSource,
  recordedAt: LicenseInstant,
});
/** One recorded license view. */
export type RecordedLicenseView = z.infer<typeof RecordedLicenseView>;

/**
 * `GET /api/platform/license` (spec 0009, AC-26), `settings.manage` only: per bundle (Warehouse
 * then Operations) its phase from the latest check, its expiry or perpetual, and the days left;
 * the latest file check; every recorded license, newest first; the manager's notices; and the
 * switched on steps a renewal would resume.
 */
export const LicenseSummary = z.object({
  bundles: z.array(LicenseBundleView),
  lastCheck: LicenseCheckView.nullable(),
  licenses: z.array(RecordedLicenseView),
  notices: z.array(LicenseNotice),
  /**
   * The executing steps switched on that cannot run now because their bundle is in its wind down
   * or `off` (AC-19): what a renewal would resume, acting only on new events. Optional so an older
   * answer still parses; the api always sends it, empty when nothing waits.
   */
  resumingSteps: z.array(z.string()).optional(),
});
/** The license summary. */
export type LicenseSummary = z.infer<typeof LicenseSummary>;

/**
 * The answer of `POST /api/platform/license` (spec 0009, AC-20): the summary after the upload,
 * `changed: false` when the license verified but granted nothing new (an older or identical one),
 * and the executing steps that resume: the steps switched on that could not run before the upload
 * and run after it (a renewal out of the wind down or `off`), which act only on new events (AC-19,
 * AC-27).
 */
export const PostLicenseAnswer = z.object({
  summary: LicenseSummary,
  changed: z.boolean(),
  resumingSteps: z.array(z.string()),
});
/** The upload answer. */
export type PostLicenseAnswer = z.infer<typeof PostLicenseAnswer>;
