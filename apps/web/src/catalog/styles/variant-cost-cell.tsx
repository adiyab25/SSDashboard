'use client';

import type { VariantCost } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/**
 * The cost in force of one variant today (spec 0012, AC-12, AC-16): the unit cost with 4
 * decimals, an "Estimate" badge when the basis is an estimate, the day it applies from, and
 * whether it comes from the style or is this variant's own override. A variant with no record
 * shows "Not set", never 0. Draw it only for a person holding `cost.view`.
 */
export function VariantCostCell({ cost }: { cost: VariantCost | undefined }) {
  const { t } = useTranslation();
  const format = useFormat();
  if (cost === undefined || cost.status === 'not_set') {
    return <span className="text-muted-foreground">{t('catalog.cost.notSet')}</span>;
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="flex flex-wrap items-center justify-end gap-2">
        {cost.costBasis === 'estimate' && (
          <Badge variant="outline">{t('catalog.cost.estimate')}</Badge>
        )}
        <span className="tabular-nums">{format.money(cost.unitCost, 4)}</span>
      </span>
      <span className="text-xs text-muted-foreground">
        {t('catalog.cost.effectiveFromWhere', {
          date: format.dateOnly(cost.effectiveFrom),
          origin:
            cost.inheritedFrom === 'style'
              ? t('catalog.cost.fromStyle')
              : t('catalog.cost.override'),
        })}
      </span>
    </div>
  );
}
