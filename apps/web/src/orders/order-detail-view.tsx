'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RecordHistoryPanel } from '@/audit/record-history-panel';
import { useAccess } from '@/access/use-access';
import { ApiError } from '@/api/client';
import { CustomerFlagBadge } from '@/customers/customer-flag-badge';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { CashChip } from './cash-chip';
import { FulfillmentChip } from './fulfillment-chip';
import { OrderActions } from './order-actions';
import { OrderDetailSkeleton } from './order-detail-skeleton';
import { OrderHoldBlock } from './order-hold-block';
import { OrderLinesSection } from './order-lines-section';
import { OrderMoneySection } from './order-money-section';
import { OrderNumber } from './order-number';
import { OrderReasonText } from './order-reason-text';
import { OrderStockOutBlock } from './order-stock-out-block';
import { OrderShipToSection } from './order-ship-to-section';
import { OrderTimelineSection } from './order-timeline-section';
import { getOrder, orderKeys } from './orders-api';

/** The campaign sources the database knows (`order_source_captured_from`); another value is shown as it is. */
const KNOWN_SOURCES = [
  'landing_page',
  'shopify_journey',
  'whatsapp_thread',
  'manual',
  'none',
] as const;

/** True for a source the catalogs name. */
function isKnownSource(value: string): value is (typeof KNOWN_SOURCES)[number] {
  return (KNOWN_SOURCES as readonly string[]).includes(value);
}

/**
 * One order (spec 0013, AC-3, AC-5, AC-20): the number with its store, type and gift reason,
 * both state chips and the outcome, the channel and source, the related order, the placed time in
 * the install's time zone, the linked customer with her risk flag, the ship to block, the lines,
 * the money, and the event timeline; the audit entries follow for a viewer holding `audit.read`.
 * The actions (confirm, pack, edit, cancel) and the "Edit not synced, hold" block sit under the
 * header (spec 0013, AC-7 to AC-12).
 */
export function OrderDetailView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const access = useAccess();
  const { orderId } = useParams<{ orderId: string }>();
  const heading = useRef<HTMLHeadingElement>(null);
  const query = useQuery({
    queryKey: orderKeys.detail(orderId),
    queryFn: ({ signal }) => getOrder(orderId, signal),
    enabled,
    retry: false,
  });
  const order = query.data;

  if (query.isError && !order) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    const rateLimited = query.error instanceof ApiError && query.error.status === 429;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('orders.detail.title')}</h1>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {notFound
              ? t('orders.detail.notFound')
              : rateLimited
                ? t('orders.detail.rateLimited')
                : t('orders.detail.loadError')}
            {!notFound && (
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                {t('orders.detail.retry')}
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/orders">{t('orders.detail.back')}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!order) return <OrderDetailSkeleton />;

  const facts: { id: string; label: string; value: React.ReactNode }[] = [
    {
      id: 'store',
      label: t('orders.detail.store'),
      value: (
        <>
          <bdi dir="auto">{text(order.storeName, order.storeCode)}</bdi>{' '}
          <span className="text-muted-foreground">
            (<LtrText>{order.storeCode}</LtrText>)
          </span>
        </>
      ),
    },
    {
      id: 'channel',
      label: t('orders.detail.channel'),
      value: <bdi dir="auto">{text(order.channelName, '')}</bdi>,
    },
    {
      id: 'type',
      label: t('orders.detail.type'),
      value: order.giftReasonCode
        ? t('orders.flags.giftedFor', { reason: t(`orders.reasons.gift.${order.giftReasonCode}`) })
        : t(`orders.type.${order.type}`),
    },
    {
      id: 'placed',
      label: t('orders.detail.placed'),
      value: format.dateTime(order.placedAt),
    },
    {
      id: 'day',
      label: t('orders.detail.operatingDay'),
      value: format.dateOnly(order.operatingDay),
    },
    {
      id: 'source',
      label: t('orders.detail.source'),
      value: (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span>
            {isKnownSource(order.source.capturedFrom) ? (
              t(`orders.source.${order.source.capturedFrom}`)
            ) : (
              <LtrText>{order.source.capturedFrom}</LtrText>
            )}
          </span>
          {[
            order.source.campaignId,
            order.source.utmSource,
            order.source.utmMedium,
            order.source.utmCampaign,
            order.source.discountCode,
          ]
            .filter((part): part is string => !!part)
            .map((part, index) => (
              <LtrText key={`${index}-${part}`} className="text-muted-foreground">
                {part}
              </LtrText>
            ))}
        </span>
      ),
    },
  ];
  if (order.relatedOrder) {
    facts.push({
      id: 'related',
      label: t(`orders.relation.${order.relatedOrder.relation}`),
      value: (
        <Link
          href={`/orders/${order.relatedOrder.id}`}
          className="rounded-chip underline-offset-4 hover:underline focus-ring"
        >
          <OrderNumber order={order.relatedOrder} />
        </Link>
      ),
    });
  }
  if (order.linkedFrom.length > 0) {
    facts.push({
      id: 'linkedFrom',
      label: t('orders.detail.linkedFrom'),
      value: (
        <ul className="flex flex-col gap-0.5">
          {order.linkedFrom.map((linked) => (
            <li key={linked.id} className="flex flex-wrap items-baseline gap-2">
              <Link
                href={`/orders/${linked.id}`}
                className="rounded-chip underline-offset-4 hover:underline focus-ring"
              >
                <OrderNumber order={linked} />
              </Link>
              <span className="text-muted-foreground">
                {t(`orders.detail.linkedFromRelation.${linked.relation}`)}
              </span>
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (order.customer) {
    facts.push({
      id: 'customer',
      label: t('orders.detail.customer'),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          {access.can('customers.view') ? (
            <Link
              href={`/customers/${order.customer.id}`}
              className="rounded-chip underline-offset-4 hover:underline focus-ring"
            >
              <bdi dir="auto">{order.customer.name ?? t('customers.unnamed')}</bdi>
            </Link>
          ) : (
            <bdi dir="auto">{order.customer.name ?? t('customers.unnamed')}</bdi>
          )}
          <CustomerFlagBadge kind={order.customer.flagKind} />
        </span>
      ),
    });
  }
  if (order.confirmedAt) {
    facts.push({
      id: 'confirmed',
      label: t('orders.detail.confirmedAt'),
      value: format.dateTime(order.confirmedAt),
    });
  }
  if (order.cancelledAt) {
    facts.push({
      id: 'cancelled',
      label: t('orders.detail.cancelledAt'),
      value: (
        <>
          {format.dateTime(order.cancelledAt)}
          {order.cancelReasonCode && (
            <>
              {' · '}
              <OrderReasonText code={order.cancelReasonCode} />
            </>
          )}
        </>
      ),
    });
  }
  if (order.carrierDeliveryCreatedAt) {
    facts.push({
      id: 'carrier',
      label: t('orders.detail.carrierDeliveryAt'),
      value: format.dateTime(order.carrierDeliveryCreatedAt),
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/orders">
          <ArrowLeftIcon aria-hidden className="rtl:rotate-180" data-icon="inline-start" />
          {t('orders.detail.back')}
        </Link>
      </Button>

      <header className="flex flex-col gap-2">
        <h1
          ref={heading}
          tabIndex={-1}
          className="rounded-chip text-xl font-semibold outline-none focus-ring"
        >
          <OrderNumber order={order} />
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <FulfillmentChip state={order.fulfillmentState} outcome={order.outcome} />
          <CashChip state={order.cashState} />
        </div>
      </header>

      <OrderActions order={order} headingRef={heading} />

      <OrderHoldBlock order={order} />

      <dl className="grid gap-x-8 gap-y-1 rounded-card gradient-card-edge p-4 sm:grid-cols-[max-content_1fr]">
        {facts.map((fact) => (
          <div key={fact.id} className="contents">
            <dt className="text-sm text-muted-foreground">{fact.label}</dt>
            <dd className="text-sm">{fact.value}</dd>
          </div>
        ))}
      </dl>

      <OrderShipToSection shipTo={order.shipTo} customerNote={order.customerNote} />
      <OrderLinesSection lines={order.lines} />
      <OrderStockOutBlock order={order} />
      <OrderMoneySection money={order.money} />
      <OrderTimelineSection events={order.events} />
      {access.can('audit.read') && <RecordHistoryPanel recordType="order" recordId={order.id} />}
    </div>
  );
}
