'use client';

import type { CustomerRiskFlag } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { useTranslation } from 'react-i18next';

/** A customer's risk flag as a word, never color alone; nothing when there is no flag. */
export function CustomerFlagBadge({ kind }: { kind: CustomerRiskFlag | null }) {
  const { t } = useTranslation();
  if (kind === null) return null;
  return <Badge variant="destructive">{t(`customers.flag.${kind}`)}</Badge>;
}
