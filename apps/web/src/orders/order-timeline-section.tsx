'use client';

import type { OrderEventView } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { OrderReasonText } from './order-reason-text';

/** `fulfillment.packed` or `cash.unpaid` as words; a state the catalog does not know is shown as is. */
function useStateLabel() {
  const { t } = useTranslation();
  return (machine: OrderEventView['machine'], state: string): string =>
    t(`orders.${machine}.${state}` as MessageKey);
}

/**
 * The event timeline (spec 0013, AC-5): every move of either state machine, oldest first as the
 * api sends it, with what moved, the amount when one came with it, who made it (the person's
 * name, or the kind of actor), the reason, and the time in the install's time zone.
 */
export function OrderTimelineSection({ events }: { events: readonly OrderEventView[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const label = useStateLabel();
  return (
    <section aria-labelledby="order-timeline-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="order-timeline-title" className="text-base font-semibold">
        {t('orders.timeline.title')}
      </h2>
      <ol className="flex flex-col divide-y rounded-card gradient-card-edge">
        {events.map((event) => (
          <li key={event.id} className="flex flex-col gap-0.5 px-4 py-2 text-sm">
            <span className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {t('orders.timeline.entry', {
                  machine: t(`orders.timeline.machine.${event.machine}`),
                  what:
                    event.fromState === null
                      ? label(event.machine, event.toState)
                      : t('orders.timeline.move', {
                          from: label(event.machine, event.fromState),
                          to: label(event.machine, event.toState),
                        }),
                })}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {format.dateTime(event.occurredAt)}
              </span>
            </span>
            <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <span>
                {event.actorName ? (
                  <bdi dir="auto">{event.actorName}</bdi>
                ) : (
                  t(`orders.timeline.actor.${event.actorType}`)
                )}
              </span>
              {event.reasonCode && (
                <span className="inline-flex gap-1">
                  <span>{t('orders.timeline.reason')}</span>
                  <OrderReasonText code={event.reasonCode} />
                </span>
              )}
              {event.amount !== null && <span>{format.money(event.amount, 2)}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
