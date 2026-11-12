'use client';

import { Badge } from '@ssdashboard/ui/components/badge';
import { useTranslation } from 'react-i18next';

/**
 * The "From Shopify" label beside a field the sales channel owns while its style is linked (spec
 * 0012, AC-15, AC-18). Plain text in a badge, so a screen reader reads it with the field and
 * colour is never the only signal. It must never make a field editable or hide one.
 */
export function FromChannelBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className="font-normal">
      {t('catalog.channel.fromShopify')}
    </Badge>
  );
}
