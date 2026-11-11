'use client';

import type { CustomerTimelineEntry as TimelineEntry } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { TimelineChannelIdEntry } from './timeline-channel-id-entry';
import { TimelineFlagEntry } from './timeline-flag-entry';
import { TimelineMergeEntry } from './timeline-merge-entry';
import { TimelineOrderEntry } from './timeline-order-entry';
import { TimelinePhoneEntry } from './timeline-phone-entry';

/**
 * One row of the customer timeline (spec 0014, AC-14): the kind in words and the time in the
 * install's time zone, then the body of that kind. Shows only what the api sent (AC-15).
 */
export function CustomerTimelineEntry({ entry }: { entry: TimelineEntry }) {
  const { t } = useTranslation();
  const format = useFormat();

  let body;
  switch (entry.kind) {
    case 'order':
      body = <TimelineOrderEntry entry={entry} />;
      break;
    case 'merge':
    case 'unmerge':
      body = <TimelineMergeEntry entry={entry} />;
      break;
    case 'phone_added':
      body = <TimelinePhoneEntry entry={entry} />;
      break;
    case 'channel_id_added':
      body = <TimelineChannelIdEntry entry={entry} />;
      break;
    case 'flag':
      body = <TimelineFlagEntry entry={entry} />;
      break;
    default: {
      const unreachable: never = entry;
      return unreachable;
    }
  }

  return (
    <li className="flex min-w-0 flex-col gap-0.5 px-4 py-3 text-sm">
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{t(`customers.profile.timeline.kind.${entry.kind}`)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {format.dateTime(entry.at)}
        </span>
      </span>
      {body}
    </li>
  );
}
