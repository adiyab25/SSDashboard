'use client';

import type { OrderShipToView } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';

/**
 * The ship to block (spec 0013, AC-5): name, phone and second phone, the address, the courier
 * note, and the customer's note. Personal data for `orders.view` holders: names and free text are
 * isolated for their direction (`bdi`), phones sit in `LtrText`. A main phone that did not parse
 * is shown as typed with a notice that it needs fixing.
 */
export function OrderShipToSection({
  shipTo,
  customerNote,
}: {
  shipTo: OrderShipToView;
  customerNote: string | null;
}) {
  const { t } = useTranslation();
  const rows: { id: string; label: string; value: React.ReactNode }[] = [];
  if (shipTo.name)
    rows.push({
      id: 'name',
      label: t('orders.shipTo.name'),
      value: <bdi dir="auto">{shipTo.name}</bdi>,
    });
  if (shipTo.phone)
    rows.push({
      id: 'phone',
      label: t('orders.shipTo.phone'),
      value: <LtrText>{shipTo.phone}</LtrText>,
    });
  if (shipTo.contactPhoneRaw) {
    rows.push({
      id: 'raw',
      label: t('orders.shipTo.phoneAsTyped'),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <LtrText>{shipTo.contactPhoneRaw}</LtrText>
          <span className="text-destructive">{t('orders.flags.phoneNeedsFix')}</span>
        </span>
      ),
    });
  }
  if (shipTo.phoneAlt)
    rows.push({
      id: 'alt',
      label: t('orders.shipTo.phoneAlt'),
      value: <LtrText>{shipTo.phoneAlt}</LtrText>,
    });
  if (shipTo.address)
    rows.push({
      id: 'address',
      label: t('orders.shipTo.address'),
      value: <bdi dir="auto">{shipTo.address}</bdi>,
    });
  if (shipTo.courierNote)
    rows.push({
      id: 'courier',
      label: t('orders.shipTo.courierNote'),
      value: <bdi dir="auto">{shipTo.courierNote}</bdi>,
    });
  if (customerNote)
    rows.push({
      id: 'note',
      label: t('orders.shipTo.customerNote'),
      value: <bdi dir="auto">{customerNote}</bdi>,
    });

  return (
    <section aria-labelledby="order-ship-to-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="order-ship-to-title" className="text-base font-semibold">
        {t('orders.shipTo.title')}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('orders.shipTo.none')}</p>
      ) : (
        <dl className="grid gap-x-8 gap-y-1 rounded-lg border p-4 sm:grid-cols-[max-content_1fr]">
          {rows.map((row) => (
            <div key={row.id} className="contents">
              <dt className="text-sm text-muted-foreground">{row.label}</dt>
              <dd className="text-sm">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
