'use client';

import { ProvisionalValue } from '@ssdashboard/ui/status/provisional-value';
import { StatusChip } from '@ssdashboard/ui/status/status-chip';
import { StatusChipOverflow } from '@ssdashboard/ui/status/status-chip-overflow';
import { useTranslation } from 'react-i18next';
import { OverflowStatusesSample } from './overflow-statuses-sample';

/**
 * Every status meaning (check, cross, coins, clock: an icon and a word, never colour alone), the
 * static "+N" overflow chip, the overflow chip that opens its hidden statuses, and a provisional
 * value. Chips are lowercase mono on the control fill with a glowing icon (spec 0025, AC-6).
 */
export function StatusChipsSample() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-wrap items-center gap-3">
        <li>
          <StatusChip meaning="confirmed" label={t('design.status.confirmed')} />
        </li>
        <li>
          <StatusChip meaning="failed" label={t('design.status.failed')} />
        </li>
        <li>
          <StatusChip meaning="owed" label={t('design.status.owed')} />
        </li>
        <li>
          <StatusChip meaning="provisional" label={t('design.status.provisional')} />
        </li>
        <li>
          <StatusChipOverflow count={2} label={t('design.status.moreStatuses')} />
        </li>
        <li>
          <OverflowStatusesSample
            label={t('design.status.moreStatuses')}
            statuses={[
              { meaning: 'failed', label: t('design.status.failed') },
              { meaning: 'owed', label: t('design.status.owed') },
            ]}
          />
        </li>
        <li>
          <ProvisionalValue
            value={t('design.status.provisionalValue')}
            provisionalLabel={t('design.status.provisional')}
          />
        </li>
      </ul>
      <p className="text-xs text-muted-foreground">{t('design.status.note')}</p>
    </div>
  );
}
