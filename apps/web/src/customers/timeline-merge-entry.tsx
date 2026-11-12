'use client';

import type {
  CustomerTimelineMergeEntry,
  CustomerTimelineUnmergeEntry,
} from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import Link from 'next/link';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import type { MergeErrorKey } from './merge-error-key';
import { TimelineReasonText } from './timeline-reason-text';
import { useMergeActions } from './use-merge-actions';

/**
 * The body of a merge or an undo entry on the customer timeline (spec 0014, AC-14, AC-15): the
 * other record with its role, who did it and why. Undo shows only when the api sent `undoable`
 * as true (it sends it only to a holder of `customers.merge`, and only while the merge can still
 * be undone), and "Open in audit" only when the api sent `audit`: the screen never decides what
 * a hat may see. Undo uses the shared undo of `useMergeActions` (reason `wrong_merge`).
 */
export function TimelineMergeEntry({
  entry,
  onUndone,
}: {
  entry: CustomerTimelineMergeEntry | CustomerTimelineUnmergeEntry;
  /** Called after an undo succeeded, so the section can put focus where the Undo button was. */
  onUndone?: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const actions = useMergeActions();
  const [undoing, setUndoing] = useState(false);
  const [failed, setFailed] = useState<MergeErrorKey | null>(null);
  const name = entry.other.name ?? t('customers.unnamed');
  const undoable = entry.kind === 'merge' && entry.undoable === true;

  async function undo() {
    // Not `disabled` while it runs: a disabled button drops keyboard focus to the page.
    if (undoing) return;
    setUndoing(true);
    setFailed(null);
    const key = await actions.undo(entry.id);
    if (key) setFailed(key);
    else onUndone?.();
    setUndoing(false);
  }

  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="text-muted-foreground">
          {t(`customers.profile.timeline.otherRole.${entry.kind}.${entry.otherRole}`)}
        </span>
        <Link
          href={`/customers/${entry.other.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          <bdi dir="auto">{name}</bdi>
        </Link>
        {entry.other.primaryPhone && <LtrText>{entry.other.primaryPhone}</LtrText>}
      </p>
      {(entry.actorName || entry.reasonCode) && (
        <p className="flex flex-wrap gap-x-3 text-muted-foreground">
          {entry.actorName && (
            <span>
              {t('customers.profile.timeline.by')} <bdi dir="auto">{entry.actorName}</bdi>
            </span>
          )}
          {entry.reasonCode && (
            <span>
              {t('customers.profile.timeline.reasonLabel')}{' '}
              <TimelineReasonText code={entry.reasonCode} />
            </span>
          )}
        </p>
      )}
      {(undoable || entry.audit) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {undoable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={undoing}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              aria-label={t('customers.profile.timeline.undoLabel', {
                name,
                date: format.date(entry.at),
              })}
              onClick={() => void undo()}
            >
              {t('customers.profile.merges.undo')}
            </Button>
          )}
          {entry.audit && (
            <Button asChild size="sm" variant="ghost">
              <Link
                href={`/audit?${new URLSearchParams({
                  recordType: entry.audit.recordType,
                  recordId: entry.audit.recordId,
                })}`}
              >
                {t('customers.profile.timeline.openInAudit')}
              </Link>
            </Button>
          )}
        </div>
      )}
      {failed && (
        <p role="alert" className="text-destructive">
          {t(failed)}
        </p>
      )}
    </>
  );
}
