'use client';

import { CustomerMergeReasonCode, CustomerUnmergeReasonCode } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';

/** The merge and undo reason codes the timeline names in words. */
const KNOWN: readonly string[] = [
  ...CustomerMergeReasonCode.options,
  ...CustomerUnmergeReasonCode.options,
];

/**
 * A merge or undo reason code in words. A code this screen has no words for is shown as it is in
 * `LtrText`, never dropped.
 */
export function TimelineReasonText({ code }: { code: string }) {
  const { t } = useTranslation();
  const known = CustomerMergeReasonCode.safeParse(code);
  const unmerge = CustomerUnmergeReasonCode.safeParse(code);
  if (!KNOWN.includes(code)) return <LtrText>{code}</LtrText>;
  if (known.success) return <>{t(`customers.profile.timeline.reasons.${known.data}`)}</>;
  if (unmerge.success) return <>{t(`customers.profile.timeline.reasons.${unmerge.data}`)}</>;
  return <LtrText>{code}</LtrText>;
}
