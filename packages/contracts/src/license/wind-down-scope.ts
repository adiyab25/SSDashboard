import { z } from 'zod';
import { compareInstants, type EffectiveState } from '../modules/module-state.js';

/**
 * The facts of one carrier delivery that the wind down scope reads (spec 0009, AC-18, D5). Feature
 * 19 passes the carrier's own creation time of the delivery, never the moment the app discovered
 * it, so a delivery created just before the lapse and seen just after is still followed.
 */
export interface CarrierScopeFacts {
  /** When the carrier created the delivery, as an ISO instant. */
  readonly carrierCreatedAt: string;
  /** When the order was confirmed, as an ISO instant, or null when it never was. */
  readonly orderConfirmedAt: string | null;
}

/**
 * Where a cut falls for carrier work (spec 0009, AC-18): the cut itself (the Operations lapse
 * instant, or the instant a module was toggled off) and the end of the pickup window after it
 * (local 00:00 of the lapse day plus `operations_wind_down_pickup_days`).
 */
export interface CarrierCut {
  readonly cutAt: string;
  readonly pickupWindowEndsAt: string;
}

/**
 * Whether a delivery is in the wind down scope of a cut (spec 0009, AC-18, D5): the carrier
 * created it before the cut, or its order was confirmed before the cut and the carrier created it
 * before the pickup window ended. Pure; it reads no clock.
 */
export function inCarrierScope(facts: CarrierScopeFacts, cut: CarrierCut): boolean {
  if (compareInstants(facts.carrierCreatedAt, cut.cutAt) < 0) return true;
  return (
    facts.orderConfirmedAt !== null &&
    compareInstants(facts.orderConfirmedAt, cut.cutAt) < 0 &&
    compareInstants(facts.carrierCreatedAt, cut.pickupWindowEndsAt) < 0
  );
}

/**
 * Where a carrier delivery stands against the Operations wind down (spec 0009, AC-18, task 21):
 * `not_lapsed` (Operations is licensed now, so nothing is cut), `in_scope` (lapsed, and the
 * delivery is still followed), or `out_of_scope` (lapsed and outside the scope, or Operations
 * was never licensed, so nothing is followed). It says nothing about whether the capability that
 * would follow it runs: callers also check the module state (`acceptsHook`, the job gate).
 */
export const WindDownScopeAnswer = z.enum(['not_lapsed', 'in_scope', 'out_of_scope']);
/** One scope answer. */
export type WindDownScopeAnswer = z.infer<typeof WindDownScopeAnswer>;

/**
 * What a hook route does with an incoming event (spec 0009, AC-8, AC-18): `process` it, or answer
 * 200 and record it `ignored_unlicensed` (the connector inbox status of the same name). A hook
 * route never answers 404 for module state.
 */
export const HookDecision = z.enum(['process', 'ignored_unlicensed']);
/** One hook decision. */
export type HookDecision = z.infer<typeof HookDecision>;

/**
 * The facts a hook passes so a `limited` capability can tell old work from new: a carrier
 * delivery (judged by the wind down scope), or any other record by the instant it was opened.
 */
export type HookScopeFacts = CarrierScopeFacts | { readonly openedAt: string };

/**
 * The hook rule (spec 0009, AC-18, task 21): an `on` capability processes every event; a
 * `limited` one processes only events of records in scope (a delivery in the carrier scope of its
 * cut, `before`, with the pickup window ending at `pickupWindowEndsAt`; any other record opened
 * before `before`), and an event with no facts is ignored; a `read_only` or `off` capability
 * ignores every event, so every Operations event after the wind down ends is recorded
 * `ignored_unlicensed`. Pure.
 */
export function hookDecision(
  state: EffectiveState,
  facts: HookScopeFacts | undefined,
  pickupWindowEndsAt: string | null,
): HookDecision {
  switch (state.state) {
    case 'on':
      return 'process';
    case 'read_only':
    case 'off':
      return 'ignored_unlicensed';
    case 'limited': {
      if (facts === undefined) return 'ignored_unlicensed';
      if ('openedAt' in facts) {
        return compareInstants(facts.openedAt, state.before) < 0 ? 'process' : 'ignored_unlicensed';
      }
      const cut = { cutAt: state.before, pickupWindowEndsAt: pickupWindowEndsAt ?? state.before };
      return inCarrierScope(facts, cut) ? 'process' : 'ignored_unlicensed';
    }
  }
}
