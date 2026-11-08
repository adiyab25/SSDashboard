import { z } from 'zod';
import { moneyInput } from '../digit-input.js';

/** The per order cost rules (spec 0002 catalog and locations, AC-32). A missing rule is `not_set`, never a silent zero. */

/** Which cost a rule sets. Matches `order_cost_rules.kind`; percents are 0 to 100, `packaging_per_order` is EGP. */
export const OrderCostRuleKind = z.enum([
  'cod_fee_percent',
  'gateway_fee_percent',
  'packaging_per_order',
  'rto_unrestocked_percent',
]);
/** One OrderCostRuleKind value. */
export type OrderCostRuleKind = z.infer<typeof OrderCostRuleKind>;

/** Whether a rule row sets a value. Matches `order_cost_rules.status`. */
export const OrderCostRuleStatus = z.enum(['set', 'not_set']);
/** One OrderCostRuleStatus value. */
export type OrderCostRuleStatus = z.infer<typeof OrderCostRuleStatus>;

/** The `numeric(14,4)` text of a rule value: 0 or more, at most 10 digits and 4 decimals. */
export const COST_RULE_VALUE_PATTERN = /^\d{1,10}(\.\d{1,4})?$/;

/** What `CostRulesService.ruleFor` answers: the value as `numeric(14,4)` text, or `not_set`. Callers must show "not set" for the latter and never treat it as 0. */
export const CostRule = z.discriminatedUnion('status', [
  z.object({ status: z.literal('set'), value: z.string().regex(COST_RULE_VALUE_PATTERN) }),
  z.object({ status: z.literal('not_set') }),
]);
/** One cost rule answer. */
export type CostRule = z.infer<typeof CostRule>;

/**
 * A rule value at the input edge (spec 0009, AC-23): typed in any digit set, normalized, and kept
 * to the `numeric(14,4)` shape of `order_cost_rules.value` (0 or more, at most 4 decimals). The
 * percent kinds are also held to 100 by `RecordCostRuleBody`, like the table check.
 */
export const CostRuleValueInput = moneyInput(4).pipe(
  z.string().regex(COST_RULE_VALUE_PATTERN, 'A value of 0 or more with at most 4 decimals'),
);

/** The kinds whose value is a percent from 0 to 100; `packaging_per_order` is EGP. */
export const PERCENT_COST_RULE_KINDS: readonly OrderCostRuleKind[] = [
  'cod_fee_percent',
  'gateway_fee_percent',
  'rto_unrestocked_percent',
];

/**
 * Body of `POST /api/platform/cost-rules` (spec 0009, AC-23): a new rule of `kind` from the
 * operating day `effectiveFrom`, either `set` with a `value` or `not_set` without one (the rules
 * of spec 0002 AC-32: a value exactly when `set`, a percent from 0 to 100), the manager's reason
 * (required, trimmed, at most 500 characters), and `inLockedPeriod: true` to record a rule from a
 * day on or before the `inventory_lock_date` setting on purpose (D14). A body that breaks a rule
 * answers 422 `SETTING_INVALID` with the issues; a missing reason 422 `REASON_REQUIRED`.
 */
export const RecordCostRuleBody = z
  .object({
    kind: OrderCostRuleKind,
    status: OrderCostRuleStatus,
    value: CostRuleValueInput.optional(),
    effectiveFrom: z.iso.date(),
    reason: z.string().trim().max(500).optional(),
    inLockedPeriod: z.boolean().optional(),
  })
  .superRefine((body, context) => {
    if ((body.status === 'set') !== (body.value !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'A value is given exactly when the rule is set',
      });
    }
    if (
      body.value !== undefined &&
      PERCENT_COST_RULE_KINDS.includes(body.kind) &&
      Number(body.value) > 100
    ) {
      context.addIssue({ code: 'custom', path: ['value'], message: 'A percent from 0 to 100' });
    }
  });
/** The validated shape of `RecordCostRuleBody`, as the api and web see it after parsing. */
export type RecordCostRuleBody = z.infer<typeof RecordCostRuleBody>;

/**
 * One recorded rule row (spec 0009, AC-23): its kind, status, value (`numeric(14,4)` text, null
 * exactly when `not_set`), the operating day it applies from, when it was recorded (UTC with
 * microseconds), and who recorded it (null for the seeded rows `migrate` writes). The reason is in
 * its audit entry (`cost_rule.recorded` or `cost_rule.recorded_in_locked_period`, record type
 * `order_cost_rule`, record id `id`).
 */
export const CostRuleRow = z.object({
  id: z.uuid(),
  kind: OrderCostRuleKind,
  status: OrderCostRuleStatus,
  value: z.string().regex(COST_RULE_VALUE_PATTERN).nullable(),
  effectiveFrom: z.iso.date(),
  recordedAt: z.iso.datetime({ offset: true }),
  recordedBy: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
});
/** The validated shape of `CostRuleRow`, as the api and web see it after parsing. */
export type CostRuleRow = z.infer<typeof CostRuleRow>;

/** Query of `GET /api/platform/cost-rules`: the history page size and the cursor of the last page. */
export const CostRulesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
/** The validated shape of `CostRulesQuery`, as the api and web see it after parsing. */
export type CostRulesQuery = z.infer<typeof CostRulesQuery>;

/**
 * Answer of `GET /api/platform/cost-rules` (spec 0009, AC-23; `cost.view`): `today` is the
 * operating day the current rules are read for; `current` holds every kind with the rule in force
 * that day (`CostRule`: `set` with a value, or `not_set`, never 0) and the row that decided it
 * (null before any row); `history` is one page of every row, newest recorded first, with
 * `nextCursor` (null on the last page); `lockDate` is the `inventory_lock_date` setting (null
 * while nothing is locked, so the page can say so), with `lockDateInvalid` when the stored value
 * fails its schema (every rule then answers 409 `LOCK_DATE_UNREADABLE`).
 */
export const CostRulesResponse = z.object({
  today: z.iso.date(),
  current: z.array(
    z.object({ kind: OrderCostRuleKind, rule: CostRule, row: CostRuleRow.nullable() }),
  ),
  history: z.object({ items: z.array(CostRuleRow), nextCursor: z.string().nullable() }),
  lockDate: z.iso.date().nullable(),
  lockDateInvalid: z.boolean(),
});
/** The validated shape of `CostRulesResponse`, as the api and web see it after parsing. */
export type CostRulesResponse = z.infer<typeof CostRulesResponse>;

/**
 * The months a rule from a day in a locked period would change (spec 0009, AC-23), as `YYYY-MM`,
 * oldest first: sent with 409 `COST_RULE_IN_LOCKED_PERIOD`.
 */
export const CostRuleLockedMonths = z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/));

/**
 * The stable error codes of the cost rule routes (spec 0009, AC-23): 422 `SETTING_INVALID` (with
 * `issues`), 422 `REASON_REQUIRED`, 409 `COST_RULE_IN_LOCKED_PERIOD` (with `months`, the locked
 * months whose margins the rule would change; send again with `inLockedPeriod: true` and a reason
 * to record it anyway), 409 `LOCK_DATE_UNREADABLE` (the lock date setting fails its schema), 400
 * `INVALID_QUERY` (a bad page size or cursor), and the guard's 403 `FORBIDDEN`.
 */
export const CostRuleErrorCode = z.enum([
  'SETTING_INVALID',
  'REASON_REQUIRED',
  'COST_RULE_IN_LOCKED_PERIOD',
  'LOCK_DATE_UNREADABLE',
  'INVALID_QUERY',
  'FORBIDDEN',
]);
/** One cost rule error code. */
export type CostRuleErrorCode = z.infer<typeof CostRuleErrorCode>;
