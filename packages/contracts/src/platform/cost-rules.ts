import { z } from 'zod';

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

/** What `CostRulesService.ruleFor` answers: the value as `numeric(14,4)` text, or `not_set`. Callers must show "not set" for the latter and never treat it as 0. */
export const CostRule = z.discriminatedUnion('status', [
  z.object({ status: z.literal('set'), value: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/) }),
  z.object({ status: z.literal('not_set') }),
]);
/** One cost rule answer. */
export type CostRule = z.infer<typeof CostRule>;
