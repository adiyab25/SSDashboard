import { z } from 'zod';

/**
 * Exact decimal amounts for the one install currency (EGP). Values are held as scaled
 * bigints (cents for `Money`, ten thousandths for `UnitCost`), so no float ever touches
 * a cost. Every rounding is half away from zero and happens once, at the end of a step.
 */

/** Thrown when an amount, cost, quantity, or rate is malformed or out of range. */
export class InvalidAmountError extends Error {
  readonly code = 'InvalidAmount';
}

/** `round(a × b / c)`, half away from zero, computed exactly. */
export function mulDivRound(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new InvalidAmountError('Division by zero');
  const numerator = a * b;
  const negative = numerator < 0n !== c < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = c < 0n ? -c : c;
  let quotient = n / d;
  if ((n % d) * 2n >= d) quotient += 1n;
  return negative ? -quotient : quotient;
}

function parseScaled(value: string, scale: number, label: string): bigint {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new InvalidAmountError(`${label} is not a decimal number: "${value}"`);
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > scale) {
    throw new InvalidAmountError(`${label} has more than ${scale} decimals: "${value}"`);
  }
  const scaled = BigInt(whole + fraction.padEnd(scale, '0'));
  return sign ? -scaled : scaled;
}

function formatScaled(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

// numeric(14,2) and numeric(14,4) hold at most 12 and 10 whole digits.
const MONEY_LIMIT = 10n ** 14n;
const UNIT_COST_LIMIT = 10n ** 14n;

/** An amount in EGP at 2 decimals, the shape of every `numeric(14,2)` column. */
export class Money {
  private constructor(readonly cents: bigint) {
    if (cents <= -MONEY_LIMIT || cents >= MONEY_LIMIT) {
      throw new InvalidAmountError(`Amount out of range: ${formatScaled(cents, 2)}`);
    }
  }

  static readonly zero = new Money(0n);

  /** Parses text or a number with at most 2 decimals; throws `InvalidAmountError` otherwise. */
  static of(value: string | number): Money {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new InvalidAmountError(`Amount is not finite: ${value}`);
    }
    return new Money(parseScaled(String(value), 2, 'Amount'));
  }

  /** Builds an amount from whole cents. */
  static fromCents(cents: bigint): Money {
    return new Money(cents);
  }

  /** Sum of two amounts. */
  plus(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  /** Difference of two amounts. */
  minus(other: Money): Money {
    return new Money(this.cents - other.cents);
  }

  /** The same amount with the opposite sign. */
  negate(): Money {
    return new Money(-this.cents);
  }

  /** `round(this × numerator / denominator)` to the cent, exact. */
  share(numerator: bigint, denominator: bigint): Money {
    return new Money(mulDivRound(this.cents, numerator, denominator));
  }

  /** -1, 0, or 1 for a negative, zero, or positive amount. */
  sign(): -1 | 0 | 1 {
    return this.cents === 0n ? 0 : this.cents < 0n ? -1 : 1;
  }

  /** True when the amount is exactly zero. */
  isZero(): boolean {
    return this.cents === 0n;
  }

  /** Exact value equality of the cents. */
  equals(other: Money): boolean {
    return this.cents === other.cents;
  }

  /** The `numeric` text form, always with 2 decimals (`-12.50`). */
  toString(): string {
    return formatScaled(this.cents, 2);
  }

  /** Serializes as the 2 decimal text so JSON never carries a float. */
  toJSON(): string {
    return this.toString();
  }
}

/** A cost per base unit at 4 decimals, the shape of every `numeric(14,4)` column. Never negative. */
export class UnitCost {
  private constructor(readonly scaled: bigint) {
    if (scaled < 0n) throw new InvalidAmountError('Unit cost cannot be negative');
    if (scaled >= UNIT_COST_LIMIT) throw new InvalidAmountError('Unit cost out of range');
  }

  static readonly zero = new UnitCost(0n);

  /** Parses text or a number with at most 4 decimals; throws `InvalidAmountError` when malformed or negative. */
  static of(value: string | number): UnitCost {
    return new UnitCost(parseScaled(String(value), 4, 'Unit cost'));
  }

  /** Builds a cost from ten thousandths of EGP. */
  static fromScaled(scaled: bigint): UnitCost {
    return new UnitCost(scaled);
  }

  /** `round(amount / quantity, 4)`, for an average or a display unit cost. */
  static perUnit(amount: Money, quantity: number): UnitCost {
    const abs = amount.cents < 0n ? -amount.cents : amount.cents;
    return new UnitCost(mulDivRound(abs, 100n, BigInt(Math.abs(quantity))));
  }

  /** `round(quantity × this, 2)`, the extended cost of whole units. */
  times(quantity: number): Money {
    return Money.fromCents(mulDivRound(this.scaled, BigInt(quantity), 100n));
  }

  /** True when the cost is exactly zero. */
  isZero(): boolean {
    return this.scaled === 0n;
  }

  /** Exact value equality. */
  equals(other: UnitCost): boolean {
    return this.scaled === other.scaled;
  }

  /** The `numeric` text form, always with 4 decimals. */
  toString(): string {
    return formatScaled(this.scaled, 4);
  }

  /** Serializes as the 4 decimal text so JSON never carries a float. */
  toJSON(): string {
    return this.toString();
  }
}

/** A whole number of units in the SKU's base unit. Signed on movements, never zero there. */
export class Quantity {
  private constructor(readonly value: number) {}

  /** A whole number; throws `InvalidAmountError` for fractions, NaN, or unsafe integers. */
  static of(value: number): Quantity {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidAmountError(`Quantity must be a whole number: ${value}`);
    }
    return new Quantity(value);
  }

  /** A movement quantity: whole and non zero. */
  static movement(value: number): Quantity {
    const quantity = Quantity.of(value);
    if (quantity.value === 0) throw new InvalidAmountError('Quantity cannot be zero');
    return quantity;
  }

  /** A document line quantity in base units: the line quantity times the unit factor. */
  static inBaseUnits(quantity: number, factor: number): Quantity {
    return Quantity.of(Quantity.of(quantity).value * Quantity.of(factor).value);
  }

  /** True for a positive quantity, stock coming in. */
  isInbound(): boolean {
    return this.value > 0;
  }

  /** The size of the quantity without its sign. */
  abs(): number {
    return Math.abs(this.value);
  }
}

/** A tax rate in percent at 2 decimals (`14.00` is 14%), the shape of `numeric(5,2)`. */
function parseTaxRate(value: string | number): bigint {
  const scaled = parseScaled(String(value), 2, 'Tax rate');
  if (scaled < 0n || scaled > 100_00n) throw new InvalidAmountError('Tax rate must be 0 to 100');
  return scaled;
}

/** What a document line supplies to `LineAmounts.compute`: quantity, price, optional discount, tax rate, and whether the price already includes VAT. */
export interface LineAmountsInput {
  /** Whole units on the line. */
  quantity: number;
  unitPrice: string | number;
  /** The line's total discount, in EGP. */
  discount?: string | number;
  taxRate: string | number;
  /** Read by callers from the `prices_include_vat` setting. */
  pricesIncludeVat: boolean;
}

/** Net, tax, and gross of one line, where gross = net + tax. */
export interface LineAmountsResult {
  net: Money;
  tax: Money;
  gross: Money;
}

/** The one rule for line amounts, used by every document module. */
export const LineAmounts = {
  /** Computes a line's amounts; throws `InvalidAmountError` for a negative quantity, price, or discount, or a discount larger than the line. */
  compute(input: LineAmountsInput): LineAmountsResult {
    const quantity = Quantity.of(input.quantity);
    if (quantity.value < 0) throw new InvalidAmountError('Line quantity cannot be negative');
    const unitPrice = Money.of(input.unitPrice);
    if (unitPrice.sign() < 0) throw new InvalidAmountError('Unit price cannot be negative');
    const discount = Money.of(input.discount ?? 0);
    if (discount.sign() < 0) throw new InvalidAmountError('Discount cannot be negative');
    const rate = parseTaxRate(input.taxRate);

    const extended = unitPrice.share(BigInt(quantity.value), 1n).minus(discount);
    if (extended.sign() < 0) throw new InvalidAmountError('Discount is larger than the line');

    if (input.pricesIncludeVat) {
      // net = gross / (1 + rate), rounded; tax = gross − net.
      const gross = extended;
      const net = gross.share(100_00n, 100_00n + rate);
      return { net, tax: gross.minus(net), gross };
    }
    // tax = net × rate, rounded; gross = net + tax.
    const net = extended;
    const tax = net.share(rate, 100_00n);
    return { net, tax, gross: net.plus(tax) };
  },
};

/** Zod shapes for amounts crossing a boundary, as `numeric` text. */
export const MoneyString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'An amount with at most 2 decimals');
/** A unit cost as `numeric(14,4)` text: 0 or more, at most 4 decimals. */
export const UnitCostString = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,4})?$/, 'A unit cost of 0 or more with at most 4 decimals');
/** A tax rate in percent as `numeric(5,2)` text, such as `14.00`. */
export const TaxRateString = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'A rate like 14.00');
