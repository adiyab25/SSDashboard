'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Money, UnitCost, UnitCostString } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { useMe } from '@/auth/use-me';
import { useFormat } from '@/i18n/use-format';
import type { MessageKey } from '@/i18n/message-key';
import {
  locationName,
  useCurrentLocation,
  useLocationSwitcher,
} from '@/shell/current-location-provider';
import { useLanguage } from '@/i18n/language-provider';
import { inventoryKeys, postReceipt } from './inventory-api';
import { SkuPicker } from './sku-picker';

const SELECT =
  'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30';

const Sku = z.object({
  id: z.string(),
  code: z.string(),
  name: z.object({ en: z.string().optional(), ar: z.string().optional() }),
});

/** The form, built from the contract's field rules (spec 0006, AC-5). */
const ReceiptForm = z.object({
  locationId: z.string().min(1, 'locationRequired'),
  receiptDate: z.iso.date(),
  reference: z.string().trim().max(64),
  note: z.string().trim().max(500),
  lines: z
    .array(
      z.object({
        sku: Sku.nullable().refine((sku) => sku !== null, 'skuRequired'),
        quantity: z
          .string()
          .trim()
          .regex(/^\d{1,7}$/, 'quantityInvalid')
          .transform(Number)
          .pipe(z.number().int().min(1, 'quantityInvalid').max(1_000_000, 'quantityInvalid')),
        unitCost: z.string().trim().pipe(UnitCostString),
      }),
    )
    .min(1)
    .max(200),
});
type ReceiptInput = z.input<typeof ReceiptForm>;
type ReceiptOutput = z.output<typeof ReceiptForm>;

const NEW_LINE = { sku: null, quantity: '', unitCost: '' } satisfies ReceiptInput['lines'][number];

/** `quantity × unitCost`, or null while either is not a valid number. */
function lineTotal(quantity: string, unitCost: string): string | null {
  if (!/^\d{1,7}$/.test(quantity.trim()) || !UnitCostString.safeParse(unitCost.trim()).success) {
    return null;
  }
  try {
    return UnitCost.of(unitCost.trim()).times(Number(quantity)).toString();
  } catch {
    return null;
  }
}

const LINE_CODES = new Set([
  'UNKNOWN_SKU',
  'ARCHIVED',
  'NOT_STOCKABLE',
  'DUPLICATE_SKU',
  'LINE_TOTAL_TOO_LARGE',
]);
/** Answers shown in the alert above the form; date faults show on the date field instead. */
const FORM_CODES = new Set(['INVALID_LINES', 'INVALID_LOCATION', 'BUSY', 'IDEMPOTENCY_CONFLICT']);
const DATE_CODES = new Set(['FUTURE_DATE', 'PERIOD_LOCKED']);

/**
 * Receive stock (spec 0006, AC-5 to AC-7): one location, a reference and note, and 1 to 200
 * lines. Posting writes the receipt, its number, and the ledger movements in one transaction.
 * The idempotency key is made once when the form opens and kept across retries (AC-6).
 */
export function ReceiptFormPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const current = useCurrentLocation();
  const { locations, status: locationsStatus } = useLocationSwitcher();
  const { language, config } = useLanguage();
  const order = {
    active: language,
    fallback: config?.defaultLanguage ?? 'en',
    enabled: config?.languages,
  };
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  // Today in the install's time zone; null until the settings load.
  const today = format.calendarDate(new Date());

  const form = useForm<ReceiptInput, unknown, ReceiptOutput>({
    resolver: zodResolver(ReceiptForm),
    mode: 'onTouched',
    defaultValues: {
      locationId: current === 'all' ? '' : current,
      receiptDate: '',
      reference: '',
      note: '',
      lines: [NEW_LINE],
    },
  });
  const { errors } = form.formState;
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const watched = useWatch({ control: form.control, name: 'lines' });
  // Where focus goes once the line list has re-rendered after an add or a remove.
  const focusTarget = useRef<{ kind: 'new-line' | 'after-remove'; index: number } | null>(null);

  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    const byId = (id: string) => document.getElementById(id);
    if (target.kind === 'new-line') {
      byId(`line-${target.index}-sku`)?.focus();
      return;
    }
    // The line that took the removed one's place, else the one before it, else Add line.
    const count = form.getValues('lines').length;
    const index = Math.min(target.index, count - 1);
    const remove = byId(`line-${index}-remove`);
    const next = remove && !remove.hasAttribute('disabled') ? remove : byId(`line-${index}-sku`);
    (next ?? byId('receipt-add-line'))?.focus();
  }, [lines.fields, form]);

  // The date starts at today once it is known, and stays the person's choice after that.
  useEffect(() => {
    if (today && !form.getFieldState('receiptDate').isDirty) {
      form.resetField('receiptDate', { defaultValue: today });
    }
  }, [today, form]);

  const mutation = useMutation({
    mutationFn: (values: ReceiptOutput) =>
      postReceipt(idempotencyKey, {
        locationId: values.locationId,
        // Sent only when the person changed it, so a retry after midnight keeps the same body.
        ...(form.getFieldState('receiptDate').isDirty && { receiptDate: values.receiptDate }),
        ...(values.reference && { reference: values.reference }),
        ...(values.note && { note: values.note }),
        lines: values.lines.map((line) => ({
          skuId: line.sku?.id ?? '',
          quantity: line.quantity,
          unitCost: line.unitCost,
        })),
      }),
    onSuccess: (receipt) => {
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.stockAll });
      queryClient.setQueryData(inventoryKeys.receipt(receipt.id), receipt);
      toast.success(t('inventory.receipt.posted', { number: receipt.number }));
      router.push(`/stock-receipts/${receipt.id}`);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      let focused = false;
      for (const fault of error.body.lineErrors ?? []) {
        if (!LINE_CODES.has(fault.code)) continue;
        form.setError(
          `lines.${fault.index}.sku`,
          { message: fault.code },
          { shouldFocus: !focused },
        );
        focused = true;
      }
      if (error.code === 'INVALID_LOCATION') {
        form.setError('locationId', { message: 'INVALID_LOCATION' }, { shouldFocus: true });
      }
      if (DATE_CODES.has(error.code)) {
        form.setError('receiptDate', { message: error.code }, { shouldFocus: true });
      }
    },
  });

  const errorCode = mutation.error instanceof ApiError ? mutation.error.code : null;
  const failure =
    errorCode && FORM_CODES.has(errorCode)
      ? (`inventory.receipt.errors.${errorCode}` as MessageKey)
      : errorCode && DATE_CODES.has(errorCode)
        ? null
        : mutation.error
          ? 'inventory.receipt.errors.generic'
          : null;

  /** Checks the date against today, then posts. The same idempotency key every time. */
  const submit = form.handleSubmit((values) => {
    if (today && values.receiptDate > today) {
      form.setError('receiptDate', { message: 'dateInvalid' }, { shouldFocus: true });
      return;
    }
    mutation.mutate(values);
  });

  const message = (code: string | undefined): string =>
    code ? t(`inventory.receipt.errors.${code}` as MessageKey) : '';

  const totalQuantity = watched.reduce(
    (sum, line) => sum + (/^\d{1,7}$/.test(line.quantity.trim()) ? Number(line.quantity) : 0),
    0,
  );
  const totals = watched.map((line) => lineTotal(line.quantity, line.unitCost));
  const valueText = totals
    .reduce((sum, total) => (total === null ? sum : sum.plus(Money.of(total))), Money.zero)
    .toString();

  const dateCode = errors.receiptDate?.message;
  const dateError = errors.receiptDate
    ? t(
        dateCode && DATE_CODES.has(dateCode)
          ? (`inventory.receipt.errors.${dateCode}` as MessageKey)
          : 'inventory.receipt.errors.dateInvalid',
      )
    : null;

  const noLocations = locationsStatus === 'empty';

  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-6"
      onSubmit={(event) => void submit(event)}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('inventory.receipt.newTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('inventory.receipt.newDescription')}</p>
      </div>

      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t(failure)}
            {errorCode === 'BUSY' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => void submit()}
              >
                {t('inventory.receipt.retry')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {noLocations && (
        <Alert>
          <AlertDescription>{t('inventory.receipt.noLocations')}</AlertDescription>
        </Alert>
      )}

      <section
        aria-labelledby="receipt-details"
        className="flex flex-col gap-4 rounded-lg border p-4"
      >
        <h2 id="receipt-details" className="text-base font-semibold">
          {t('inventory.receipt.details')}
        </h2>
        <FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field data-invalid={!!errors.locationId}>
            <FieldLabel htmlFor="receipt-location">
              {t('inventory.receipt.location')}
              <span className="font-normal text-muted-foreground">({t('inventory.required')})</span>
            </FieldLabel>
            <select
              id="receipt-location"
              className={SELECT}
              aria-required
              aria-invalid={!!errors.locationId}
              aria-describedby={errors.locationId ? 'receipt-location-error' : undefined}
              disabled={noLocations}
              {...form.register('locationId')}
            >
              <option value="">{t('inventory.receipt.chooseLocation')}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {`${locationName(location, order)} · ${location.code}`}
                </option>
              ))}
            </select>
            <FieldError id="receipt-location-error">
              {errors.locationId ? message(errors.locationId.message) : null}
            </FieldError>
          </Field>

          <Field data-invalid={!!errors.receiptDate}>
            <FieldLabel htmlFor="receipt-date">{t('inventory.receipt.date')}</FieldLabel>
            <Input
              id="receipt-date"
              type="date"
              dir="ltr"
              max={today ?? undefined}
              className="tabular-nums"
              aria-invalid={!!errors.receiptDate}
              aria-describedby={errors.receiptDate ? 'receipt-date-error' : 'receipt-date-hint'}
              {...form.register('receiptDate')}
            />
            {errors.receiptDate ? (
              <FieldError id="receipt-date-error">{dateError}</FieldError>
            ) : (
              <FieldDescription id="receipt-date-hint">
                {t('inventory.receipt.dateHint')}
              </FieldDescription>
            )}
          </Field>

          <Field data-invalid={!!errors.reference}>
            <FieldLabel htmlFor="receipt-reference">
              {t('inventory.receipt.reference')}
              <span className="font-normal text-muted-foreground">({t('inventory.optional')})</span>
            </FieldLabel>
            <Input
              id="receipt-reference"
              dir="ltr"
              maxLength={64}
              autoComplete="off"
              aria-describedby="receipt-reference-hint"
              {...form.register('reference')}
            />
            <FieldDescription id="receipt-reference-hint">
              {t('inventory.receipt.referenceHint')}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="receipt-note">
              {t('inventory.receipt.note')}
              <span className="font-normal text-muted-foreground">({t('inventory.optional')})</span>
            </FieldLabel>
            <Textarea id="receipt-note" rows={2} maxLength={500} {...form.register('note')} />
          </Field>
        </FieldGroup>
      </section>

      <section
        aria-labelledby="receipt-lines"
        className="flex flex-col gap-4 rounded-lg border p-4"
      >
        <h2 id="receipt-lines" className="text-base font-semibold">
          {t('inventory.receipt.lines')}
        </h2>
        <ol className="flex flex-col gap-4">
          {lines.fields.map((line, index) => {
            const number = index + 1;
            const lineErrors = errors.lines?.[index];
            const skuError = lineErrors?.sku?.message;
            const total = totals[index] ?? null;
            return (
              <li
                key={line.id}
                aria-label={t('inventory.receipt.line', { number })}
                className="grid items-start gap-3 border-b pb-4 last:border-b-0 last:pb-0 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
              >
                <Field data-invalid={!!skuError}>
                  <FieldLabel htmlFor={`line-${index}-sku`}>
                    {t('inventory.receipt.sku')}
                  </FieldLabel>
                  <Controller
                    control={form.control}
                    name={`lines.${index}.sku`}
                    render={({ field }) => (
                      <SkuPicker
                        id={`line-${index}-sku`}
                        value={field.value}
                        onChange={(sku) => {
                          field.onChange(sku);
                          form.clearErrors(`lines.${index}.sku`);
                        }}
                        onBlur={field.onBlur}
                        buttonRef={field.ref}
                        invalid={!!skuError}
                        describedBy={skuError ? `line-${index}-sku-error` : undefined}
                      />
                    )}
                  />
                  <FieldError id={`line-${index}-sku-error`}>
                    {skuError ? message(skuError) : null}
                  </FieldError>
                </Field>

                <Field data-invalid={!!lineErrors?.quantity}>
                  <FieldLabel htmlFor={`line-${index}-quantity`}>
                    {t('inventory.receipt.quantity')}
                  </FieldLabel>
                  <Input
                    id={`line-${index}-quantity`}
                    dir="ltr"
                    inputMode="numeric"
                    autoComplete="off"
                    className="tabular-nums"
                    aria-invalid={!!lineErrors?.quantity}
                    aria-describedby={
                      lineErrors?.quantity ? `line-${index}-quantity-error` : undefined
                    }
                    {...form.register(`lines.${index}.quantity`)}
                  />
                  <FieldError id={`line-${index}-quantity-error`}>
                    {lineErrors?.quantity ? t('inventory.receipt.errors.quantityInvalid') : null}
                  </FieldError>
                </Field>

                <Field data-invalid={!!lineErrors?.unitCost}>
                  <FieldLabel htmlFor={`line-${index}-cost`}>
                    {t('inventory.receipt.unitCost')}
                  </FieldLabel>
                  <Input
                    id={`line-${index}-cost`}
                    dir="ltr"
                    inputMode="decimal"
                    autoComplete="off"
                    className="tabular-nums"
                    aria-invalid={!!lineErrors?.unitCost}
                    aria-describedby={lineErrors?.unitCost ? `line-${index}-cost-error` : undefined}
                    {...form.register(`lines.${index}.unitCost`)}
                  />
                  <FieldError id={`line-${index}-cost-error`}>
                    {lineErrors?.unitCost ? t('inventory.receipt.errors.unitCostInvalid') : null}
                  </FieldError>
                </Field>

                {isAdmin ? (
                  <div className="flex flex-col gap-2 md:min-w-28 md:text-end">
                    <span className="text-sm font-medium">{t('inventory.receipt.lineTotal')}</span>
                    <span className="flex h-control items-center text-sm tabular-nums md:justify-end">
                      {total === null ? '' : format.money(total, 2)}
                    </span>
                  </div>
                ) : (
                  <span className="hidden md:block" />
                )}

                <div className="flex md:pt-7">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="coarse:size-touch"
                    id={`line-${index}-remove`}
                    disabled={lines.fields.length === 1}
                    aria-label={t('inventory.receipt.removeLine', { number })}
                    onClick={() => {
                      lines.remove(index);
                      focusTarget.current = { kind: 'after-remove', index };
                    }}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        <div>
          <Button
            type="button"
            variant="outline"
            id="receipt-add-line"
            disabled={lines.fields.length >= 200}
            onClick={() => {
              lines.append(NEW_LINE, { shouldFocus: false });
              focusTarget.current = { kind: 'new-line', index: lines.fields.length };
            }}
          >
            <PlusIcon aria-hidden data-icon="inline-start" />
            {t('inventory.receipt.addLine')}
          </Button>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <dl className="flex flex-wrap gap-6 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">{t('inventory.receipt.totalQuantity')}</dt>
            <dd className="font-medium tabular-nums">{format.quantity(totalQuantity)}</dd>
          </div>
          {isAdmin && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('inventory.receipt.referenceValue')}</dt>
              <dd className="font-medium tabular-nums">{format.money(valueText, 2)}</dd>
            </div>
          )}
        </dl>
        <Button
          type="submit"
          disabled={mutation.isPending || noLocations}
          aria-busy={mutation.isPending}
        >
          {mutation.isPending && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('inventory.receipt.post')}
        </Button>
      </div>
    </form>
  );
}
