import { COST_VIEW_DEFAULT, StaffHat } from '@ssdashboard/contracts';

/**
 * The hats a manager can give on the people screen, in catalog order: the four internal hats and
 * `media_buyer`, never `partner` (spec 0008, AC-12 and AC-14). Read from the contract, never copied.
 */
export const STAFF_HATS: readonly StaffHat[] = StaffHat.options;

/**
 * Where the cost switch stands while a manager ticks hats and has not moved the switch by hand
 * (spec 0008, AC-7 and the value sourcing table): on when a hat being added starts with cost
 * (`COST_VIEW_DEFAULT`, owner default: `manager` and `operations`), else the stored grant (false
 * for a new person). A default only ever turns the switch on, so ticking a hat never quietly
 * takes away cost a person already sees. Pure; it never decides whether a change is allowed, and
 * a person who may not change cost (no `cost.view`) never gets a prefill: see `canChange`.
 */
export function startingCostView(input: {
  /** The hats ticked now. */
  hats: readonly StaffHat[];
  /** The hats the person wore when the dialog opened (empty for a new person). */
  storedHats: readonly StaffHat[];
  /** Whether the person held `cost.view` when the dialog opened (false for a new person). */
  storedCostView: boolean;
  /** False when the signed in person lacks `cost.view`: the stored grant stays, whatever is ticked. */
  canChange: boolean;
}): boolean {
  const { hats, storedHats, storedCostView, canChange } = input;
  if (!canChange) return storedCostView;
  const added = hats.filter((hat) => !storedHats.includes(hat));
  return storedCostView || added.some((hat) => COST_VIEW_DEFAULT[hat]);
}

/** The ticked hats in catalog order, so what is sent and shown never depends on click order. */
export function inCatalogOrder(hats: Iterable<StaffHat>): StaffHat[] {
  const ticked = new Set(hats);
  return STAFF_HATS.filter((hat) => ticked.has(hat));
}
