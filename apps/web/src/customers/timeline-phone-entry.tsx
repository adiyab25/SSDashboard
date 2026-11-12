'use client';

import type { CustomerTimelinePhoneEntry } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';

/** The body of a phone entry on the customer timeline (spec 0014, AC-14): the number in `LtrText`, its kind, and Primary when it is. */
export function TimelinePhoneEntry({ entry }: { entry: CustomerTimelinePhoneEntry }) {
  const { t } = useTranslation();
  return (
    <p className="flex flex-wrap items-center gap-x-2">
      <LtrText>{entry.e164}</LtrText>
      <span className="text-muted-foreground">
        {t(`customers.profile.phones.kind.${entry.phoneKind}`)}
      </span>
      {entry.isPrimary && (
        <Badge variant="secondary">{t('customers.profile.phones.primary')}</Badge>
      )}
    </p>
  );
}
