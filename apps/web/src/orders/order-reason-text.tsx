'use client';

import {
  CancelReasonCode,
  GiftReasonCode,
  LineRemovalReasonCode,
  ORDER_CREATED_MANUALLY_REASONS,
  ORDER_EDITED_REASONS,
  RefusedReasonCode,
} from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';

/** The reason code lists in the order a code is looked up: the first list holding it names it. */
const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['cancel', CancelReasonCode.options],
  ['edit', ORDER_EDITED_REASONS],
  ['gift', GiftReasonCode.options],
  ['lineRemoval', [...LineRemovalReasonCode.options, 'edit_removal']],
  ['created', ORDER_CREATED_MANUALLY_REASONS],
  ['refused', RefusedReasonCode.options],
];

/**
 * A reason code in words, from the cancel, edit, gift, line removal, created, or refused (a carrier's refusal) lists. A code no
 * list holds (a channel's or the carrier's own, such as `channel.fake`) is shown as it is, in
 * `LtrText`, never dropped.
 */
export function OrderReasonText({ code }: { code: string }) {
  const { t } = useTranslation();
  const group = GROUPS.find(([, codes]) => codes.includes(code));
  if (!group) return <LtrText>{code}</LtrText>;
  return <>{t(`orders.reasons.${group[0]}.${code}` as MessageKey)}</>;
}
