import { Money, UnitCost } from '@ssdashboard/contracts';

/**
 * The ledger's cost rules (spec 0002, Value sourcing). Pure: a balance and a line in,
 * the movement's costs and the next balance out. Every share is exact and rounded once.
 */

export interface BalanceState {
  onHand: number;
  totalValue: Money;
  /** Kept at its last value when on hand reaches 0 or below. */
  avgUnitCost: UnitCost;
}

export interface CostedLine {
  totalCost: Money;
  unitCost: UnitCost;
  costVariance: Money;
  costUnknown: boolean;
  next: BalanceState;
}

function nextBalance(
  balance: BalanceState,
  quantity: number,
  totalCost: Money,
  averageChanges: boolean,
): BalanceState {
  const onHand = balance.onHand + quantity;
  const totalValue = balance.totalValue.plus(totalCost);
  return {
    onHand,
    totalValue,
    // Inbound: round(new total_value / new on_hand, 4), the formula a rebuild uses.
    // Outbound never changes the average.
    avgUnitCost:
      averageChanges && onHand > 0 ? UnitCost.perUnit(totalValue, onHand) : balance.avgUnitCost,
  };
}

/**
 * An inbound line at `price` per unit. `referenceCost` overrides the cost the variance is
 * measured against (a reversal measures against the original movement's cost).
 */
export function costInbound(
  balance: BalanceState,
  quantity: number,
  price: UnitCost,
  referenceCost: Money = price.times(quantity),
): CostedLine {
  if (quantity <= 0) throw new RangeError('costInbound needs a positive quantity');
  let totalCost: Money;
  if (balance.onHand >= 0) {
    totalCost = price.times(quantity);
  } else {
    const shortfall = -balance.onHand;
    if (quantity >= shortfall) {
      // The units filling the shortfall take exactly its value; only the rest cost the price.
      totalCost = balance.totalValue.negate().plus(price.times(quantity - shortfall));
    } else {
      // Both negative, so the share is positive.
      totalCost = balance.totalValue.share(BigInt(quantity), BigInt(balance.onHand));
    }
  }
  return {
    totalCost,
    unitCost: price,
    costVariance: referenceCost.minus(totalCost),
    costUnknown: false,
    next: nextBalance(balance, quantity, totalCost, true),
  };
}

/** An outbound line (negative `quantity`), costed from the balance. */
export function costOutbound(
  balance: BalanceState,
  quantity: number,
  referenceCost?: Money,
): CostedLine {
  if (quantity >= 0) throw new RangeError('costOutbound needs a negative quantity');
  const units = -quantity;
  let totalCost: Money;
  let costUnknown = false;
  if (balance.onHand > 0) {
    if (units >= balance.onHand) {
      // Emptying the balance takes exactly what is left; units beyond cost the kept average.
      const extra = balance.avgUnitCost.times(units - balance.onHand);
      totalCost = balance.totalValue.plus(extra).negate();
    } else {
      totalCost = balance.totalValue.share(BigInt(units), BigInt(balance.onHand)).negate();
    }
  } else if (balance.avgUnitCost.isZero()) {
    // The balance never had a cost: record 0 and flag it for the accountant.
    totalCost = Money.zero;
    costUnknown = true;
  } else {
    totalCost = balance.avgUnitCost.times(units).negate();
  }
  return {
    totalCost,
    unitCost: UnitCost.perUnit(totalCost, units),
    costVariance: referenceCost ? referenceCost.minus(totalCost) : Money.zero,
    costUnknown,
    next: nextBalance(balance, quantity, totalCost, false),
  };
}
