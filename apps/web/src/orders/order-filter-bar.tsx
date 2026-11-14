'use client';

import {
  CashState,
  FulfillmentState,
  OrderOutcome,
  OrderType,
  type OrderFilterOptions,
} from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { XIcon } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { SELECT_CLASS } from './order-field-classes';
import { EMPTY_FILTERS, isFiltered, type OrderFilters } from './order-filters';

/** Adds or removes one value from a list, keeping the enum's own order. */
function toggled<T extends string>(all: readonly T[], current: readonly T[], value: T): T[] {
  return all.filter((item) => (item === value ? !current.includes(value) : current.includes(item)));
}

const CHECK_LABEL = 'inline-flex items-center gap-2 text-sm coarse:min-h-touch';

/**
 * The filters of the order list (spec 0013, AC-4): store and channel (once they load), type, outcome, the fulfillment and cash states (several), hold, short lines, the
 * operating day range, and the customer filter that arrives from the customer page. Every change
 * applies at once; the search box and its text live in the list view, not here.
 */
export function OrderFilterBar({
  value,
  onChange,
  options,
}: {
  value: OrderFilters;
  onChange: (next: OrderFilters) => void;
  /** Every store and channel to choose from; null until they load or when they cannot. */
  options: OrderFilterOptions | null;
}) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const id = useId();
  const set = (patch: Partial<OrderFilters>) => onChange({ ...value, ...patch });

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-card gradient-card-edge p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {t('orders.filters.title')}
        </h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!isFiltered(value) && value.customerId === ''}
          onClick={() => onChange({ ...EMPTY_FILTERS, q: value.q })}
        >
          <XIcon aria-hidden data-icon="inline-start" />
          {t('orders.filters.clear')}
        </Button>
      </div>

      {value.customerId && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {t('orders.filters.customerOnly')}
          <Button type="button" size="sm" variant="outline" onClick={() => set({ customerId: '' })}>
            {t('orders.filters.customerClear')}
          </Button>
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {options && (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-store`}>{t('orders.filters.store')}</FieldLabel>
              <select
                id={`${id}-store`}
                className={SELECT_CLASS}
                value={value.storeId}
                onChange={(event) => set({ storeId: event.target.value })}
              >
                <option value="">{t('orders.filters.anyStore')}</option>
                {options.stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {`${store.code} · ${text(store.name, store.code)}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-channel`}>{t('orders.filters.channel')}</FieldLabel>
              <select
                id={`${id}-channel`}
                className={SELECT_CLASS}
                value={value.channelId}
                onChange={(event) => set({ channelId: event.target.value })}
              >
                <option value="">{t('orders.filters.anyChannel')}</option>
                {options.channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {text(channel.name, channel.code)}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field>
          <FieldLabel htmlFor={`${id}-type`}>{t('orders.filters.type')}</FieldLabel>
          <select
            id={`${id}-type`}
            className={SELECT_CLASS}
            value={value.type}
            onChange={(event) => set({ type: OrderType.safeParse(event.target.value).data ?? '' })}
          >
            <option value="">{t('orders.filters.anyType')}</option>
            {OrderType.options.map((type) => (
              <option key={type} value={type}>
                {t(`orders.type.${type}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-outcome`}>{t('orders.filters.outcome')}</FieldLabel>
          <select
            id={`${id}-outcome`}
            className={SELECT_CLASS}
            value={value.outcome}
            onChange={(event) =>
              set({ outcome: OrderOutcome.safeParse(event.target.value).data ?? '' })
            }
          >
            <option value="">{t('orders.filters.anyOutcome')}</option>
            {OrderOutcome.options.map((outcome) => (
              <option key={outcome} value={outcome}>
                {t(`orders.outcome.${outcome}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-from`}>{t('orders.filters.dayFrom')}</FieldLabel>
          <Input
            id={`${id}-from`}
            type="date"
            dir="ltr"
            className="tabular-nums"
            value={value.dayFrom}
            max={value.dayTo || undefined}
            onChange={(event) => set({ dayFrom: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-to`}>{t('orders.filters.dayTo')}</FieldLabel>
          <Input
            id={`${id}-to`}
            type="date"
            dir="ltr"
            className="tabular-nums"
            value={value.dayTo}
            min={value.dayFrom || undefined}
            onChange={(event) => set({ dayTo: event.target.value })}
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className={CHECK_LABEL}>
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={value.hold}
            onChange={(event) => set({ hold: event.target.checked })}
          />
          {t('orders.filters.hold')}
        </label>
        <label className={CHECK_LABEL}>
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={value.short}
            onChange={(event) => set({ short: event.target.checked })}
          />
          {t('orders.filters.short')}
        </label>
      </div>

      <details>
        <summary className="w-fit cursor-pointer rounded-chip text-sm font-medium focus-ring coarse:min-h-touch">
          {t('orders.filters.byState')}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('orders.filters.fulfillment')}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {FulfillmentState.options.map((state) => (
                <label key={state} className={CHECK_LABEL}>
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={value.fulfillment.includes(state)}
                    onChange={() =>
                      set({
                        fulfillment: toggled(FulfillmentState.options, value.fulfillment, state),
                      })
                    }
                  />
                  {t(`orders.fulfillment.${state}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('orders.filters.cash')}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {CashState.options.map((state) => (
                <label key={state} className={CHECK_LABEL}>
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={value.cash.includes(state)}
                    onChange={() => set({ cash: toggled(CashState.options, value.cash, state) })}
                  />
                  {t(`orders.cash.${state}`)}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </details>
    </section>
  );
}
