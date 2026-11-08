import {
  COST_RULE_VALUE_PATTERN,
  PERCENT_COST_RULE_KINDS,
  type OrderCostRuleKind,
} from '@ssdashboard/contracts';
import { InvalidDigitInputError, parseMoney } from '@ssdashboard/i18n';

/** Whether a rule of this kind is a percent from 0 to 100 (else an amount per order). Pure. */
export function isPercentKind(kind: OrderCostRuleKind): boolean {
  return PERCENT_COST_RULE_KINDS.includes(kind);
}

/**
 * How many decimals a rule value shows, as an amount or a percent: 2, unless the stored
 * `numeric(14,4)` text carries a third or fourth decimal that is not zero, so a value is never
 * shown rounded. Pure.
 */
export function shownDigits(value: string): 2 | 4 {
  const fraction = value.split('.')[1] ?? '';
  return /[1-9]/.test(fraction.slice(2)) ? 4 : 2;
}

/** Why a typed rule value cannot be sent, or the value as `numeric` text. */
export type RuleValueCheck =
  { ok: true; value: string } | { ok: false; problem: 'required' | 'invalid' | 'percentTooHigh' };

/**
 * Reads a typed rule value (Western or Arabic digits, 0 or more, at most 10 integer digits and 4
 * decimals) into the `numeric` text the api takes, refusing an empty one, a malformed or too long
 * one (`COST_RULE_VALUE_PATTERN`), and a percent over 100 before any request (the same rules as
 * `RecordCostRuleBody`, which the api applies again). Pure.
 */
export function checkRuleValue(text: string, kind: OrderCostRuleKind): RuleValueCheck {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, problem: 'required' };
  let value: string;
  try {
    value = parseMoney(trimmed, 4);
  } catch (error) {
    if (error instanceof InvalidDigitInputError) return { ok: false, problem: 'invalid' };
    throw error;
  }
  // The `numeric(14,4)` shape: 0 or more, at most 10 integer digits and 4 decimals.
  if (!COST_RULE_VALUE_PATTERN.test(value)) return { ok: false, problem: 'invalid' };
  if (isPercentKind(kind) && Number(value) > 100) return { ok: false, problem: 'percentTooHigh' };
  return { ok: true, value };
}
