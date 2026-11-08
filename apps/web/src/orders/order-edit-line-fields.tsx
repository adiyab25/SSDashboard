'use client';

import { Field, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { useRef } from 'react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { SkuPicker } from '@/inventory/sku-picker';
import type { OrderEditInput, OrderEditOutput } from './order-edit-form';

/**
 * The SKU, quantity, unit price, and discount of one line in the edit dialog, for a replaced or an
 * added line (spec 0013, AC-9), built like the new order form's line: the SKU picker searches the
 * catalog (`GET /api/skus?q=`), numbers are `ltr` with tabular figures, and each problem sits under
 * its field. A gifted order's line has no discount field: it keeps its price with an equal
 * discount (AC-2). `prefix` keeps the element ids unique per row.
 */
export function OrderEditLineFields({
  form,
  index,
  gifted,
  prefix,
}: {
  form: UseFormReturn<OrderEditInput, unknown, OrderEditOutput>;
  /** The row's place in the form's `lines`. */
  index: number;
  gifted: boolean;
  /** The start of every element id of this row. */
  prefix: string;
}) {
  const { t } = useTranslation();
  // What the last SKU pick wrote into the price and the discount, so a later pick can tell it from typing.
  const filled = useRef<{ price?: string; discount?: string }>({});
  const lineErrors = form.formState.errors.lines?.[index];
  const skuError = lineErrors?.sku?.message;

  return (
    <div
      className={`grid items-start gap-3 ${
        gifted
          ? 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]'
          : 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]'
      }`}
    >
      <Field data-invalid={!!skuError}>
        <FieldLabel htmlFor={`${prefix}-sku`}>{t('orders.lines.sku')}</FieldLabel>
        <Controller
          control={form.control}
          name={`lines.${index}.sku`}
          render={({ field }) => (
            <SkuPicker
              id={`${prefix}-sku`}
              value={field.value}
              placeholder={t('orders.new.chooseSku')}
              onChange={(sku) => {
                const changed = field.value?.id !== sku.id;
                field.onChange(sku);
                form.clearErrors(`lines.${index}.sku`);
                // Another SKU starts from its own list price (empty when it has none, so the
                // old SKU's price is never carried over) and no discount, but only over a value
                // the person has not typed: the starting value, or what an earlier pick filled.
                if (changed) {
                  const start = form.formState.defaultValues?.lines?.[index];
                  const price = form.getValues(`lines.${index}.unitPrice`);
                  if (price === (start?.unitPrice ?? '') || price === filled.current.price) {
                    filled.current.price = sku.price ?? '';
                    form.setValue(`lines.${index}.unitPrice`, filled.current.price);
                  }
                  const discount = form.getValues(`lines.${index}.discountAmount`);
                  if (
                    discount === (start?.discountAmount ?? '0.00') ||
                    discount === filled.current.discount
                  ) {
                    filled.current.discount = '0.00';
                    form.setValue(`lines.${index}.discountAmount`, '0.00');
                  }
                }
              }}
              onBlur={field.onBlur}
              buttonRef={field.ref}
              invalid={!!skuError}
              describedBy={skuError ? `${prefix}-sku-error` : undefined}
            />
          )}
        />
        <FieldError id={`${prefix}-sku-error`}>
          {skuError ? t('orders.new.errors.skuRequired') : null}
        </FieldError>
      </Field>

      <Field data-invalid={!!lineErrors?.quantity}>
        <FieldLabel htmlFor={`${prefix}-quantity`}>{t('orders.lines.quantity')}</FieldLabel>
        <Input
          id={`${prefix}-quantity`}
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          className="tabular-nums"
          aria-invalid={!!lineErrors?.quantity}
          aria-describedby={lineErrors?.quantity ? `${prefix}-quantity-error` : undefined}
          {...form.register(`lines.${index}.quantity`)}
        />
        <FieldError id={`${prefix}-quantity-error`}>
          {lineErrors?.quantity ? t('orders.new.errors.quantityInvalid') : null}
        </FieldError>
      </Field>

      <Field data-invalid={!!lineErrors?.unitPrice}>
        <FieldLabel htmlFor={`${prefix}-price`}>{t('orders.lines.unitPrice')}</FieldLabel>
        <Input
          id={`${prefix}-price`}
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          className="tabular-nums"
          aria-invalid={!!lineErrors?.unitPrice}
          aria-describedby={lineErrors?.unitPrice ? `${prefix}-price-error` : undefined}
          {...form.register(`lines.${index}.unitPrice`)}
        />
        <FieldError id={`${prefix}-price-error`}>
          {lineErrors?.unitPrice ? t('orders.new.errors.amountInvalid') : null}
        </FieldError>
      </Field>

      {!gifted && (
        <Field data-invalid={!!lineErrors?.discountAmount}>
          <FieldLabel htmlFor={`${prefix}-discount`}>{t('orders.lines.discount')}</FieldLabel>
          <Input
            id={`${prefix}-discount`}
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            className="tabular-nums"
            aria-invalid={!!lineErrors?.discountAmount}
            aria-describedby={lineErrors?.discountAmount ? `${prefix}-discount-error` : undefined}
            {...form.register(`lines.${index}.discountAmount`)}
          />
          <FieldError id={`${prefix}-discount-error`}>
            {lineErrors?.discountAmount ? t('orders.new.errors.amountInvalid') : null}
          </FieldError>
        </Field>
      )}
    </div>
  );
}
