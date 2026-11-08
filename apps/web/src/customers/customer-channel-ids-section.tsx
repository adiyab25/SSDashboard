'use client';

import type { CustomerChannelIdView } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';

const COLUMNS = ['kind', 'id', 'source', 'added'] as const;

/**
 * Every id an outside system gave the customer, with the store or channel it came from (AC-4).
 * One customer may hold Shopify ids from two stores; a label the api could not resolve (null)
 * shows its code, or "Not known yet", never a blank.
 */
export function CustomerChannelIdsSection({ ids }: { ids: readonly CustomerChannelIdView[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();

  const sourceOf = (item: CustomerChannelIdView): string => {
    if (item.storeName && item.storeCode) return text(item.storeName, item.storeCode);
    if (item.storeCode) return item.storeCode;
    if (item.channelName && item.channelCode) return text(item.channelName, item.channelCode);
    if (item.channelCode) return item.channelCode;
    return t('customers.profile.channelIds.sourceUnknown');
  };

  return (
    <section aria-labelledby="customer-channel-ids-title" className="flex flex-col gap-2">
      <h2 id="customer-channel-ids-title" className="text-base font-semibold">
        {t('customers.profile.channelIds.title')}
      </h2>
      {ids.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('customers.profile.channelIds.empty')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table aria-label={t('customers.profile.channelIds.tableLabel')}>
            <TableHeader className="bg-muted">
              <TableRow className="h-row-header hover:bg-muted">
                {COLUMNS.map((column) => (
                  <TableHead key={column} scope="col" className="px-3 text-start font-medium">
                    {t(`customers.profile.channelIds.columns.${column}`)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ids.map((item) => (
                <TableRow key={item.id} className="h-row hover:bg-muted">
                  <TableCell className="px-3">
                    {t(`customers.profile.channelIds.kind.${item.kind}`)}
                  </TableCell>
                  <TableCell className="px-3">
                    <LtrText>{item.externalId}</LtrText>
                  </TableCell>
                  <TableCell className="px-3">{sourceOf(item)}</TableCell>
                  <TableCell className="px-3">{format.dateTime(item.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
