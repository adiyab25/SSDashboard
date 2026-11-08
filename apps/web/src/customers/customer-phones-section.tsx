'use client';

import type { CustomerPhoneView } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
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

const COLUMNS = ['number', 'kind', 'firstSeen', 'lastSeen'] as const;

/** Every phone the customer holds over all her ids, primary first, with its kind and when it was first and last seen (AC-4). */
export function CustomerPhonesSection({ phones }: { phones: readonly CustomerPhoneView[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <section aria-labelledby="customer-phones-title" className="flex flex-col gap-2">
      <h2 id="customer-phones-title" className="text-base font-semibold">
        {t('customers.profile.phones.title')}
      </h2>
      <div className="overflow-hidden rounded-lg border">
        <Table aria-label={t('customers.profile.phones.tableLabel')}>
          <TableHeader className="bg-muted">
            <TableRow className="h-row-header hover:bg-muted">
              {COLUMNS.map((column) => (
                <TableHead key={column} scope="col" className="px-3 text-start font-medium">
                  {t(`customers.profile.phones.columns.${column}`)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {phones.map((phone) => (
              <TableRow key={phone.e164} className="h-row hover:bg-muted">
                <TableCell className="px-3">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <LtrText>{phone.e164}</LtrText>
                    {phone.isPrimary && (
                      <Badge variant="secondary">{t('customers.profile.phones.primary')}</Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="px-3">
                  {t(`customers.profile.phones.kind.${phone.kind}`)}
                </TableCell>
                <TableCell className="px-3">{format.dateTime(phone.firstSeenAt)}</TableCell>
                <TableCell className="px-3">{format.dateTime(phone.lastSeenAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
