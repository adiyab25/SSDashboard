import { z } from 'zod';
import { MoneyString } from '../money.js';
import { LicenseDate } from './license-envelope.js';
import { daysBetween } from './license-phase.js';

/** An instant as the report carries it, ISO 8601 with an offset. */
const ReportInstant = z.iso.datetime({ offset: true });

/** An area or job name in the report: lowercase words joined by `_` or `.`, never free text. */
const ReportArea = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);

/**
 * The reduced daily report of the Operations wind down (spec 0009, AC-18, D7, task 22), the
 * content contract feature 25 sends to the brand's own report channel: the phase, the lapse, the
 * wind down's last day and the days left in it, the pre lapse cash still expected (the count and
 * amount of open items: orders not in a final cash state, from the settlement module), and what
 * failed (per area or job, a count). `final` marks the last report, sent when the wind down ends,
 * which links to the settlement module's "open after the wind down" list. No price, no commercial
 * term, no personal data.
 */
export const WindDownReport = z.object({
  phase: z.enum(['wind_down', 'off']),
  lapsedAt: ReportInstant,
  windDownEndsOn: LicenseDate,
  windDownDaysLeft: z.int().min(0),
  expectedCash: z.object({ count: z.int().min(0), amount: MoneyString }),
  failed: z.array(z.object({ area: ReportArea, count: z.int().min(1) })),
  final: z.boolean(),
});
/** One reduced report. */
export type WindDownReport = z.infer<typeof WindDownReport>;

/**
 * The days left in the wind down on `today` (both `YYYY-MM-DD`): the days until its last day,
 * never below zero. Pure.
 */
export function windDownDaysLeft(windDownEndsOn: string, today: string): number {
  return Math.max(0, daysBetween(today, windDownEndsOn));
}
