'use client';

import type { CostRule, OrderCostRuleKind } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { isPercentKind, shownDigits } from './cost-rule-value';

/**
 * Returns the words of the Cost rules page (spec 0009, AC-23): a kind's name, and a rule as the
 * person reads it: a percent through `useFormat().percent` and an amount per order through
 * `useFormat().money`, both with up to 4 decimals when the stored text has them (never rounded
 * away), and "Not set" for `not_set`, never 0.
 */
export function useCostRuleText(): {
  kindName: (kind: OrderCostRuleKind) => string;
  rule: (kind: OrderCostRuleKind, rule: CostRule) => string;
} {
  const { t } = useTranslation();
  const format = useFormat();
  return {
    kindName: (kind) => t(`settings.costRules.kinds.${kind}`),
    rule: (kind, rule) => {
      if (rule.status === 'not_set') return t('settings.costRules.notSet');
      return isPercentKind(kind)
        ? format.percent(rule.value, { digits: shownDigits(rule.value) })
        : format.money(rule.value, shownDigits(rule.value));
    },
  };
}
