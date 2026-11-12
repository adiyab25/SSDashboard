'use client';

import type { CustomerTimelineChannelIdEntry } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';
import { useLocalizedText } from '@/i18n/use-localized-text';

/** The body of a channel id entry on the customer timeline (spec 0014, AC-14): the kind, the id in `LtrText`, and the store or channel it came from. */
export function TimelineChannelIdEntry({ entry }: { entry: CustomerTimelineChannelIdEntry }) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  let source: string = t('customers.profile.channelIds.sourceUnknown');
  if (entry.storeName && entry.storeCode) source = text(entry.storeName, entry.storeCode);
  else if (entry.storeCode) source = entry.storeCode;
  else if (entry.channelName && entry.channelCode)
    source = text(entry.channelName, entry.channelCode);
  else if (entry.channelCode) source = entry.channelCode;
  return (
    <p className="flex flex-wrap items-center gap-x-2">
      <span>{t(`customers.profile.channelIds.kind.${entry.channelIdKind}`)}</span>
      <LtrText>{entry.externalId}</LtrText>
      <span className="text-muted-foreground">{source}</span>
    </p>
  );
}
