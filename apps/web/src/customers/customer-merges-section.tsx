'use client';

import type { CustomerAbsorbedMerge } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { useFormat } from '@/i18n/use-format';
import { useMergeActions } from './use-merge-actions';

/**
 * The records merged into this customer: who they were and when (spec 0014, AC-4, AC-8). A merge
 * that is still the latest one for both customers shows Undo (`undoable`) to a person with
 * `customers.merge`; Undo puts the record back with the reason `wrong_merge`. Nothing when none.
 */
export function CustomerMergesSection({ merges }: { merges: readonly CustomerAbsorbedMerge[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const access = useAccess();
  const actions = useMergeActions();
  const [undoing, setUndoing] = useState<string | null>(null);
  if (merges.length === 0) return null;
  const canUndo = access.can('customers.merge');

  async function undo(mergeId: string) {
    setUndoing(mergeId);
    await actions.undo(mergeId);
    setUndoing(null);
  }

  return (
    <section aria-labelledby="customer-merges-title" className="flex flex-col gap-2">
      <h2 id="customer-merges-title" className="text-base font-semibold">
        {t('customers.profile.merges.title')}
      </h2>
      <ul className="flex flex-col gap-1 text-sm">
        {merges.map((merge) => (
          <li key={merge.mergeId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">
              <bdi dir="auto">{merge.other.name ?? t('customers.unnamed')}</bdi>
            </span>
            {merge.other.primaryPhone && <LtrText>{merge.other.primaryPhone}</LtrText>}
            <span className="text-muted-foreground">
              {t('customers.profile.merges.item', { date: format.dateTime(merge.at) })}
            </span>
            {canUndo && merge.undoable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={undoing === merge.mergeId}
                aria-label={t('customers.profile.merges.undoLabel', {
                  name: merge.other.name ?? t('customers.unnamed'),
                })}
                onClick={() => void undo(merge.mergeId)}
              >
                {t('customers.profile.merges.undo')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
