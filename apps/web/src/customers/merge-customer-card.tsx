'use client';

import type { CustomerChannelIdView, CustomerProfile } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { Label } from '@ssdashboard/ui/components/label';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { RadioGroupItem } from '@ssdashboard/ui/components/radio-group';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { CustomerFlagBadge } from './customer-flag-badge';

interface Props {
  slot: 'first' | 'second';
  /** The loaded customer, or null while loading or after a failed load. */
  profile: CustomerProfile | null;
  /** True while the customer loads; false once there is an answer. */
  loading: boolean;
  /** True when the customer could not be loaded. */
  failed: boolean;
  /** True for the older record of the two (shown with a badge). */
  older: boolean;
  /** Draw the Keep radio. It must sit inside the page's survivor `RadioGroup`. */
  selectable: boolean;
  /** Move focus to the card when it first shows, after the person picked this customer. */
  focusOnMount: boolean;
  /** Empties the slot so the person can find another customer. */
  onChange: () => void;
}

/**
 * One side of the merge comparison (spec 0014, AC-7): the name, flag, when the record was added,
 * every phone, and every channel id, plus the radio that makes it the record to keep and the
 * button to choose another customer. Phones and ids sit in `LtrText`. It loads nothing itself.
 */
export function MergeCustomerCard({
  slot,
  profile,
  loading,
  failed,
  older,
  selectable,
  focusOnMount,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const heading = useRef<HTMLHeadingElement>(null);
  const settled = !loading;

  useEffect(() => {
    if (!focusOnMount || !settled) return;
    // The picked button is gone, so focus sits on the body. If the person already moved on (typing
    // in the other slot's search), leave their focus alone: stealing it loses the typed text's Enter.
    const active = document.activeElement;
    if (active === null || active === document.body) heading.current?.focus();
  }, [focusOnMount, settled]);

  const sourceOf = (item: CustomerChannelIdView): string => {
    if (item.storeName && item.storeCode) return text(item.storeName, item.storeCode);
    if (item.storeCode) return item.storeCode;
    if (item.channelName && item.channelCode) return text(item.channelName, item.channelCode);
    if (item.channelCode) return item.channelCode;
    return t('customers.profile.channelIds.sourceUnknown');
  };

  return (
    <section
      aria-labelledby={`merge-card-${slot}`}
      className="flex min-w-0 flex-col gap-3 rounded-card gradient-card-edge p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id={`merge-card-${slot}`}
          ref={heading}
          tabIndex={-1}
          className="text-sm font-semibold text-muted-foreground outline-none"
        >
          {t(`customers.merge.slot.${slot}`)}
        </h2>
        <Button type="button" size="sm" variant="ghost" onClick={onChange}>
          {t('customers.merge.card.change')}
        </Button>
      </div>

      {loading && (
        <div
          role="status"
          aria-label={t('customers.merge.card.loading')}
          className="flex flex-col gap-2"
        >
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {failed && (
        <Alert variant="destructive">
          <AlertDescription>{t('customers.merge.card.loadError')}</AlertDescription>
        </Alert>
      )}

      {profile && (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-semibold">
                <bdi dir="auto">{profile.name ?? t('customers.unnamed')}</bdi>
              </p>
              <CustomerFlagBadge kind={profile.flag?.kind ?? null} />
              {older && <Badge variant="secondary">{t('customers.merge.compare.older')}</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {t('customers.merge.card.added', { date: format.date(profile.createdAt) })}
            </p>
            {profile.orderCount !== undefined && (
              <p className="text-sm text-muted-foreground">
                {t('customers.merge.card.orders', { number: format.number(profile.orderCount) })}
              </p>
            )}
            {profile.flag === null && (
              <p className="text-sm text-muted-foreground">{t('customers.merge.card.noFlag')}</p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">{t('customers.merge.card.phones')}</h3>
            <ul className="flex flex-col gap-0.5 text-sm">
              {profile.phones.map((phone) => (
                <li key={phone.e164} className="flex flex-wrap items-center gap-2">
                  <LtrText>{phone.e164}</LtrText>
                  {phone.isPrimary && (
                    <Badge variant="secondary">{t('customers.profile.phones.primary')}</Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">{t('customers.merge.card.channelIds')}</h3>
            {profile.channelIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('customers.merge.card.noChannelIds')}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm">
                {profile.channelIds.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-2">
                    <span>{t(`customers.profile.channelIds.kind.${item.kind}`)}</span>
                    <LtrText>{item.externalId}</LtrText>
                    <span className="text-muted-foreground">{sourceOf(item)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {selectable && (
            <div className="flex items-center gap-2 border-t pt-3">
              <RadioGroupItem value={slot} id={`merge-keep-${slot}`} />
              <Label htmlFor={`merge-keep-${slot}`}>{t('customers.merge.compare.keep')}</Label>
            </div>
          )}
        </>
      )}
    </section>
  );
}
