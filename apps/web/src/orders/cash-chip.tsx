'use client';

import type { CashState } from '@ssdashboard/contracts';
import { StatusChip } from '@ssdashboard/ui/status/status-chip';
import { useTranslation } from 'react-i18next';

/**
 * The money's state as a `StatusChip`: cash still owed (by the customer or the courier, the label
 * names who) is `owed`, cash we hold or were paid is `confirmed`. "Nothing to collect" is plain
 * muted text: it is no status that needs a hue (DESIGN.md, Status colors).
 */
export function CashChip({ state }: { state: CashState }) {
  const { t } = useTranslation();
  const label = t(`orders.cash.${state}`);
  switch (state) {
    case 'unpaid':
    case 'collected_by_carrier':
      return <StatusChip meaning="owed" label={label} />;
    case 'remitted':
    case 'reconciled':
    case 'prepaid':
      return <StatusChip meaning="confirmed" label={label} />;
    case 'nothing_to_collect':
      return <span className="text-xs text-muted-foreground">{label}</span>;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
