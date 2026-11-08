import { z } from 'zod';
import { compareInstants, type EffectiveState } from './module-state.js';

/**
 * Why a capability catches up a gap (spec 0009, AC-11, AC-19): its module was turned back on
 * (`module_resumed`), or its bundle was renewed out of the wind down or `off` (`renewed`).
 */
export const BackfillCause = z.enum(['module_resumed', 'renewed']);
/** One backfill cause. */
export type BackfillCause = z.infer<typeof BackfillCause>;

/**
 * The gap a capability's `backfill` hook catches up (spec 0009, AC-11, AC-19, AC-27): from the
 * instant it stopped (the toggle off write, or the lapse instant) to the instant it ran again (the
 * toggle on write, or the renewing check). The backfill contract every later feature follows:
 * it imports provider facts only, records them with the `system` actor and `BACKFILL_MARKER`, and
 * never acts toward a customer or an outside system: it sends no command, opens no queue work for
 * a record whose next step already happened outside the app, and its events never trigger an
 * executing step.
 */
export const BackfillGap = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  cause: BackfillCause,
});
/** One backfill gap. */
export type BackfillGap = z.infer<typeof BackfillGap>;

/** The marker a backfill stamps on what it records, so nothing treats it as fresh work (AC-27). */
export const BACKFILL_MARKER = 'backfill';

/**
 * The step watermark (spec 0009, AC-27, task 21): whether a capability or executing step in
 * `state` may act on a record whose triggering event happened at `eventAt`. Only an `on` one acts,
 * and only on events at or after its `since` (the latest of the step's switch on, its module's
 * turn on, and its bundle's renewal out of a lapse; null means on since the install). A `limited`
 * capability finishes old records and never reacts to an event. The Shopify stock push, a state
 * push, does not ask this (AC-27). Pure.
 */
export function actsOnEvent(state: EffectiveState, eventAt: string): boolean {
  if (state.state !== 'on') return false;
  return state.since === null || compareInstants(eventAt, state.since) >= 0;
}
