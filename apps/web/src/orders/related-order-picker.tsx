'use client';

import type { OrderRef } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ssdashboard/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@ssdashboard/ui/components/popover';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useEffect, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { EMPTY_FILTERS } from './order-filters';
import { OrderNumber } from './order-number';
import { listOrders, orderKeys } from './orders-api';

const SEARCH_DELAY_MS = 250;
const RESULTS = 20;

interface Props {
  id: string;
  value: OrderRef | null;
  onChange: (order: OrderRef) => void;
  onBlur?: () => void;
  invalid?: boolean;
  describedBy?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
  /** An order the list never offers, such as the order being cancelled as a duplicate of another. */
  excludeId?: string;
}

/**
 * Picks the order a new one is linked to (spec 0013, AC-23): a combobox that searches by phone or
 * order number through `POST /api/orders/search`, so a typed phone never reaches a URL. It shows
 * the store beside each number (AC-3). Keyboard: Enter or Space opens it, arrows move, Enter
 * picks, Esc closes. Needs `orders.view`, which every holder of `orders.confirm` has.
 */
export function RelatedOrderPicker({
  id,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
  buttonRef,
  disabled,
  excludeId,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(input.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [input]);

  const results = useQuery({
    queryKey: orderKeys.picker(q),
    queryFn: ({ signal }) => listOrders({ ...EMPTY_FILTERS, q }, undefined, signal, RESULTS),
    enabled: open && q !== '',
    retry: false,
  });

  const pending = input.trim() !== q || (q !== '' && results.isFetching && !results.data);
  const failure = results.error instanceof ApiError ? results.error : null;
  const statusText = pending
    ? t('orders.new.related.searching')
    : q === ''
      ? t('orders.new.related.hint')
      : results.isError
        ? failure?.status === 429
          ? t('orders.new.related.rateLimited')
          : t('orders.new.related.error')
        : results.data && results.data.items.filter((order) => order.id !== excludeId).length === 0
          ? t('orders.new.related.none')
          : '';
  const items =
    pending || q === ''
      ? []
      : (results.data?.items ?? []).filter((order) => order.id !== excludeId);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onBlur?.();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={buttonRef}
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="w-full min-w-0 justify-between bg-field font-normal"
        >
          {value ? (
            <OrderNumber order={value} className="font-medium" />
          ) : (
            <span className="text-muted-foreground">{t('orders.new.related.choose')}</span>
          )}
          <ChevronsUpDownIcon aria-hidden className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            value={input}
            onValueChange={setInput}
            placeholder={t('orders.new.related.search')}
          />
          <CommandList>
            <div
              role="status"
              className={`px-3 py-4 text-sm empty:hidden ${
                results.isError && !pending ? 'text-destructive' : 'text-muted-foreground'
              }`}
            >
              {statusText}
            </div>
            <CommandGroup>
              {items.map((order) => (
                <CommandItem
                  key={order.id}
                  value={order.id}
                  className="coarse:min-h-touch"
                  onSelect={() => {
                    onChange({
                      id: order.id,
                      storeCode: order.storeCode,
                      orderNumber: order.orderNumber,
                    });
                    setOpen(false);
                    onBlur?.();
                  }}
                >
                  <CheckIcon aria-hidden className={value?.id === order.id ? '' : 'invisible'} />
                  <OrderNumber order={order} className="font-medium" />
                  {order.shipToName && (
                    <bdi dir="auto" className="truncate text-muted-foreground">
                      {order.shipToName}
                    </bdi>
                  )}
                  <span className="ms-auto text-xs text-muted-foreground">
                    {t(`orders.fulfillment.${order.fulfillmentState}`)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
