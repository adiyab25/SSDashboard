'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CreateGiftedOrderBody,
  CreateManualOrderBody,
  GiftReasonCode,
  LineAmounts,
  ManualPaymentMethod,
  Money,
  moneyInput,
  orderLabelOf,
  PriceString,
  quantityInput,
  type OrderOptions,
  type RelatedOrderInput,
} from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { useAccess } from '@/access/use-access';
import { ApiError } from '@/api/client';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { SkuPicker } from '@/inventory/sku-picker';
import { SELECT_CLASS } from '@/shared/select-class';
import { newIdempotencyKey } from './new-idempotency-key';
import { NewOrderSkeleton } from './new-order-skeleton';
import { createGiftedOrder, createOrder, getOrderOptions, orderKeys } from './orders-api';
import { RelatedOrderPicker } from './related-order-picker';

const Sku = z.object({
  id: z.string(),
  code: z.string(),
  name: z.object({ en: z.string().optional(), ar: z.string().optional() }),
  price: z.string().nullable().optional(),
});

const Amount = moneyInput(2).pipe(PriceString);

/** The form, built from the contract's field rules (spec 0013, AC-1, AC-2, AC-23). */
const NewOrderForm = z
  .object({
    mode: z.enum(['sale', 'gifted']),
    storeId: z.string().min(1, 'storeRequired'),
    channelId: z.string().min(1, 'channelRequired'),
    giftReasonCode: z.string(),
    /** `reopened_from` or `replacement_for` on a sale; empty for none. A goodwill link is implied by its reason. */
    relation: z.enum(['', 'reopened_from', 'replacement_for']),
    related: z
      .object({ id: z.string(), storeCode: z.string(), orderNumber: z.string() })
      .nullable(),
    name: z.string().trim().min(1, 'required').max(200),
    phone: z.string().trim().min(1, 'required').max(64),
    phoneAlt: z.string().trim().max(64),
    address: z.string().trim().min(1, 'required').max(500),
    courierNote: z.string().trim().max(500),
    lines: z
      .array(
        z.object({
          sku: Sku.nullable().refine((sku) => sku !== null, 'skuRequired'),
          quantity: quantityInput({ min: 1, max: 10_000 }),
          unitPrice: Amount,
          discountAmount: Amount,
        }),
      )
      .min(1)
      .max(100),
    shippingChargedAmount: Amount,
    paymentMethod: ManualPaymentMethod,
  })
  .superRefine((form, ctx) => {
    if (form.mode === 'gifted' && !GiftReasonCode.safeParse(form.giftReasonCode).success) {
      ctx.addIssue({ code: 'custom', path: ['giftReasonCode'], message: 'giftReasonRequired' });
    }
    if (form.mode === 'gifted') {
      form.lines.forEach((line, index) => {
        if (Number(line.unitPrice) <= 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['lines', index, 'unitPrice'],
            message: 'giftPriceRequired',
          });
        }
      });
    }
    const linked =
      (form.mode === 'sale' && form.relation !== '') ||
      (form.mode === 'gifted' && form.giftReasonCode === 'replacement_goodwill');
    if (linked && form.related === null) {
      ctx.addIssue({ code: 'custom', path: ['related'], message: 'relatedRequired' });
    }
  });
type NewOrderInput = z.input<typeof NewOrderForm>;
type NewOrderOutput = z.output<typeof NewOrderForm>;

const NEW_LINE = {
  sku: null,
  quantity: '',
  unitPrice: '',
  discountAmount: '0.00',
} satisfies NewOrderInput['lines'][number];

/** The two kinds of order the form takes. */
const ORDER_KINDS = ['sale', 'gifted'] as const;

/** Answers the page shows in the alert above the form, each with its own message. */
const FORM_CODES = new Set([
  'INVALID_BODY',
  'STORE_NOT_INTERNAL',
  'CHANNEL_NOT_ALLOWED',
  'VARIANT_UNKNOWN',
  'PARTIAL_PREPAYMENT_NOT_SUPPORTED',
  'RELATED_ORDER_STATE',
  'RELATED_ORDER_UNKNOWN',
  'RELATED_ORDER_OTHER_CUSTOMER',
  'ALREADY_REOPENED',
  'LINE_FULLY_DISCOUNTED',
  'GIFT_MUST_STAY_FREE',
  'BUSY',
  'FORBIDDEN',
]);

/** The typed quantity as a whole number in range, in any digit set, else null. */
function quantityOf(text: string): number | null {
  const parsed = quantityInput({ min: 1, max: 10_000 }).safeParse(text);
  return parsed.success ? parsed.data : null;
}

/** The typed amount as a normalized decimal string, else null. */
function amountOf(text: string): string | null {
  const parsed = Amount.safeParse(text);
  return parsed.success ? parsed.data : null;
}

/**
 * The order total as the api will compute it (lines gross with the install's tax rule, plus
 * shipping), or null while any figure is not a valid number. A gifted order's lines are fully
 * discounted, so its total is 0. Used to show the total and to send a full prepayment.
 */
function totalOf(
  values: {
    mode: NewOrderInput['mode'];
    lines: { quantity: string | number; unitPrice: string; discountAmount: string }[];
    shippingChargedAmount: string;
  },
  options: OrderOptions,
): string | null {
  const shipping = values.mode === 'gifted' ? '0.00' : amountOf(values.shippingChargedAmount);
  if (shipping === null) return null;
  let total = Money.of(shipping);
  for (const line of values.lines) {
    const quantity = quantityOf(String(line.quantity));
    const price = amountOf(line.unitPrice);
    const discount = values.mode === 'gifted' ? price : amountOf(line.discountAmount);
    if (quantity === null || price === null || discount === null) return null;
    try {
      const gross = LineAmounts.compute({
        quantity,
        unitPrice: price,
        discount:
          values.mode === 'gifted'
            ? Money.of(price).share(BigInt(quantity), 1n).toString()
            : discount,
        taxRate: options.salesTaxRate,
        pricesIncludeVat: options.pricesIncludeVat,
      }).gross;
      total = total.plus(gross);
    } catch {
      return null;
    }
  }
  return total.toString();
}

/**
 * The new order form (spec 0013, AC-1, AC-2, AC-23, AC-20): store and channel, a sale or (with
 * `orders.gift`) a gifted order with its reason, an optional link to a related order, the ship to
 * fields, 1 to 100 lines picked from the catalog, shipping, and the payment. The idempotency
 * `clientRef` is made once when the form opens and kept across retries, so a repeat never makes a
 * second order. A gifted order's lines keep their price with an equal discount and its shipping is 0.
 */
export function NewOrderView() {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const access = useAccess();
  const canGift = access.can('orders.gift');
  const [clientRef] = useState(() => newIdempotencyKey());

  const options = useQuery({
    queryKey: orderKeys.options,
    queryFn: ({ signal }) => getOrderOptions(signal),
    retry: false,
  });
  const offered = options.data;

  const form = useForm<NewOrderInput, unknown, NewOrderOutput>({
    resolver: zodResolver(NewOrderForm),
    mode: 'onTouched',
    defaultValues: {
      mode: 'sale',
      storeId: '',
      channelId: '',
      giftReasonCode: '',
      relation: '',
      related: null,
      name: '',
      phone: '',
      phoneAlt: '',
      address: '',
      courierNote: '',
      lines: [NEW_LINE],
      shippingChargedAmount: '0.00',
      paymentMethod: 'cod',
    },
  });
  const { errors } = form.formState;
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const watched = useWatch({ control: form.control });
  const mode = watched.mode ?? 'sale';
  const gifted = mode === 'gifted';
  const reason = watched.giftReasonCode ?? '';
  const goodwill = gifted && reason === 'replacement_goodwill';
  const linkedKind = goodwill ? 'goodwill_for' : gifted ? '' : (watched.relation ?? '');
  const focusTarget = useRef<{ kind: 'new-line' | 'after-remove'; index: number } | null>(null);

  // With one store or one channel to choose from, it is already chosen.
  useEffect(() => {
    if (!offered) return;
    const only = (items: readonly { id: string }[], field: 'storeId' | 'channelId') => {
      const [first] = items;
      if (items.length === 1 && first && !form.getFieldState(field).isDirty) {
        form.setValue(field, first.id);
      }
    };
    only(offered.stores, 'storeId');
    only(offered.channels, 'channelId');
  }, [offered, form]);

  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    const byId = (id: string) => document.getElementById(id);
    if (target.kind === 'new-line') {
      byId(`line-${target.index}-sku`)?.focus();
      return;
    }
    const count = form.getValues('lines').length;
    const index = Math.min(target.index, count - 1);
    const remove = byId(`line-${index}-remove`);
    const next = remove && !remove.hasAttribute('disabled') ? remove : byId(`line-${index}-sku`);
    (next ?? byId('order-add-line'))?.focus();
  }, [lines.fields, form]);

  const mutation = useMutation({
    mutationFn: (values: NewOrderOutput) => {
      if (!offered) throw new Error('options not loaded');
      const total = totalOf(values, offered);
      const link: RelatedOrderInput | null =
        values.related && linkedKind !== ''
          ? { orderId: values.related.id, relation: linkedKind }
          : null;
      const common = {
        clientRef,
        storeId: values.storeId,
        channelId: values.channelId,
        ...(link && { relatedOrder: link }),
        shipTo: {
          name: values.name,
          phone: values.phone,
          phoneAlt: values.phoneAlt || null,
          address: values.address,
          courierNote: values.courierNote || null,
        },
        lines: values.lines.map((line) => ({
          variantId: line.sku?.id ?? '',
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount:
            values.mode === 'gifted'
              ? Money.of(line.unitPrice).share(BigInt(line.quantity), 1n).toString()
              : line.discountAmount,
        })),
      };
      if (values.mode === 'gifted') {
        return createGiftedOrder(
          CreateGiftedOrderBody.parse({
            ...common,
            shippingChargedAmount: '0.00',
            giftReasonCode: values.giftReasonCode,
          }),
        );
      }
      return createOrder(
        CreateManualOrderBody.parse({
          ...common,
          shippingChargedAmount: values.shippingChargedAmount,
          paymentMethod: values.paymentMethod,
          prepaidAmount: values.paymentMethod === 'cod' ? '0.00' : (total ?? '0.00'),
        }),
      );
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
      // The label is isolated so `MAIN/SO-…` keeps its order inside right to left text.
      toast.success(t('orders.new.created', { order: `⁦${orderLabelOf(created)}⁩` }));
      router.push(`/orders/${created.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'INVALID_PHONE_ALT') {
        form.setError('phoneAlt', { message: 'INVALID_PHONE_ALT' }, { shouldFocus: true });
      }
    },
  });

  const error = mutation.error;
  const apiError = error instanceof ApiError ? error : null;
  const failure: MessageKey | null = !error
    ? null
    : apiError?.code === 'INVALID_PHONE_ALT'
      ? null
      : error instanceof z.ZodError
        ? 'orders.new.errors.invalidForm'
        : apiError?.status === 429
          ? 'orders.new.errors.rateLimited'
          : apiError && FORM_CODES.has(apiError.code)
            ? (`orders.new.errors.${apiError.code}` as MessageKey)
            : 'orders.new.errors.generic';

  const message = (code: string | undefined): string =>
    code ? t(`orders.new.errors.${code}` as MessageKey) : '';

  const total = offered
    ? totalOf(
        {
          mode,
          lines: (watched.lines ?? []).map((line) => ({
            quantity: line?.quantity ?? '',
            unitPrice: line?.unitPrice ?? '',
            discountAmount: line?.discountAmount ?? '',
          })),
          shippingChargedAmount: watched.shippingChargedAmount ?? '',
        },
        offered,
      )
    : null;

  if (options.isPending) return <NewOrderSkeleton />;
  if (!offered) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('orders.new.title')}</h1>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('orders.new.optionsError')}
            <Button size="sm" variant="outline" onClick={() => void options.refetch()}>
              {t('orders.new.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-6"
      onSubmit={(event) => void form.handleSubmit((values) => mutation.mutate(values))(event)}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('orders.new.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('orders.new.description')}</p>
      </div>

      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t(failure)}</AlertDescription>
        </Alert>
      )}

      <section
        aria-labelledby="order-details"
        className="flex flex-col gap-4 rounded-card gradient-card-edge p-4"
      >
        <h2 id="order-details" className="text-base font-semibold">
          {t('orders.new.details')}
        </h2>
        <FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field data-invalid={!!errors.storeId}>
            <FieldLabel htmlFor="order-store">
              {t('orders.new.store')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.required')})
              </span>
            </FieldLabel>
            <select
              id="order-store"
              className={SELECT_CLASS}
              aria-required
              aria-invalid={!!errors.storeId}
              aria-describedby={errors.storeId ? 'order-store-error' : undefined}
              {...form.register('storeId')}
            >
              <option value="">{t('orders.new.chooseStore')}</option>
              {offered.stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {`${store.code} · ${text(store.name, store.code)}`}
                </option>
              ))}
            </select>
            <FieldError id="order-store-error">{message(errors.storeId?.message)}</FieldError>
          </Field>

          <Field data-invalid={!!errors.channelId}>
            <FieldLabel htmlFor="order-channel">
              {t('orders.new.channel')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.required')})
              </span>
            </FieldLabel>
            <select
              id="order-channel"
              className={SELECT_CLASS}
              aria-required
              aria-invalid={!!errors.channelId}
              aria-describedby={errors.channelId ? 'order-channel-error' : undefined}
              {...form.register('channelId')}
            >
              <option value="">{t('orders.new.chooseChannel')}</option>
              {offered.channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {text(channel.name, channel.code)}
                </option>
              ))}
            </select>
            <FieldError id="order-channel-error">{message(errors.channelId?.message)}</FieldError>
          </Field>

          {canGift && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t('orders.new.kind')}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {ORDER_KINDS.map((kind) => (
                  <label
                    key={kind}
                    className="inline-flex items-center gap-2 text-sm coarse:min-h-touch"
                  >
                    <input
                      type="radio"
                      value={kind}
                      className="size-4 accent-primary"
                      {...form.register('mode')}
                    />
                    {t(`orders.new.kinds.${kind}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {gifted ? (
            <Field data-invalid={!!errors.giftReasonCode}>
              <FieldLabel htmlFor="order-gift-reason">
                {t('orders.new.giftReason')}
                <span className="font-normal text-muted-foreground">
                  ({t('orders.new.required')})
                </span>
              </FieldLabel>
              <select
                id="order-gift-reason"
                className={SELECT_CLASS}
                aria-required
                aria-invalid={!!errors.giftReasonCode}
                aria-describedby={errors.giftReasonCode ? 'order-gift-reason-error' : undefined}
                {...form.register('giftReasonCode')}
              >
                <option value="">{t('orders.new.chooseGiftReason')}</option>
                {offered.giftReasonCodes.map((code) => (
                  <option key={code} value={code}>
                    {t(`orders.reasons.gift.${code}`)}
                  </option>
                ))}
              </select>
              <FieldError id="order-gift-reason-error">
                {message(errors.giftReasonCode?.message)}
              </FieldError>
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="order-payment">{t('orders.new.payment')}</FieldLabel>
              <select
                id="order-payment"
                className={SELECT_CLASS}
                {...form.register('paymentMethod')}
              >
                {ManualPaymentMethod.options.map((method) => (
                  <option key={method} value={method}>
                    {t(`orders.paymentMethod.${method}`)}
                  </option>
                ))}
              </select>
              <FieldDescription>{t('orders.new.paymentHint')}</FieldDescription>
            </Field>
          )}
        </FieldGroup>
      </section>

      {(!gifted || goodwill) && (
        <section
          aria-labelledby="order-related"
          className="flex flex-col gap-4 rounded-card gradient-card-edge p-4"
        >
          <h2 id="order-related" className="text-base font-semibold">
            {t('orders.new.related.title')}
          </h2>
          <FieldGroup className="grid gap-4 md:grid-cols-2">
            {goodwill ? (
              <p className="text-sm text-muted-foreground md:col-span-2">
                {t('orders.relation.goodwill_for')}
              </p>
            ) : (
              <Field>
                <FieldLabel htmlFor="order-relation">{t('orders.new.related.relation')}</FieldLabel>
                <select id="order-relation" className={SELECT_CLASS} {...form.register('relation')}>
                  <option value="">{t('orders.new.related.noLink')}</option>
                  <option value="reopened_from">{t('orders.relation.reopened_from')}</option>
                  <option value="replacement_for">{t('orders.relation.replacement_for')}</option>
                </select>
              </Field>
            )}
            {linkedKind !== '' && (
              <Field data-invalid={!!errors.related}>
                <FieldLabel htmlFor="order-related-order">
                  {t('orders.new.related.order')}
                  <span className="font-normal text-muted-foreground">
                    ({t('orders.new.required')})
                  </span>
                </FieldLabel>
                <Controller
                  control={form.control}
                  name="related"
                  render={({ field }) => (
                    <RelatedOrderPicker
                      id="order-related-order"
                      value={field.value}
                      onChange={(order) => {
                        field.onChange(order);
                        form.clearErrors('related');
                      }}
                      onBlur={field.onBlur}
                      buttonRef={field.ref}
                      invalid={!!errors.related}
                      describedBy={errors.related ? 'order-related-error' : undefined}
                    />
                  )}
                />
                <FieldError id="order-related-error">{message(errors.related?.message)}</FieldError>
              </Field>
            )}
          </FieldGroup>
        </section>
      )}

      <section
        aria-labelledby="order-ship-to"
        className="flex flex-col gap-4 rounded-card gradient-card-edge p-4"
      >
        <h2 id="order-ship-to" className="text-base font-semibold">
          {t('orders.shipTo.title')}
        </h2>
        <FieldGroup className="grid gap-4 md:grid-cols-2">
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="order-name">
              {t('orders.shipTo.name')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.required')})
              </span>
            </FieldLabel>
            <Input
              id="order-name"
              dir="auto"
              maxLength={200}
              autoComplete="off"
              aria-required
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? 'order-name-error' : undefined}
              {...form.register('name')}
            />
            <FieldError id="order-name-error">{message(errors.name?.message)}</FieldError>
          </Field>
          <Field data-invalid={!!errors.phone}>
            <FieldLabel htmlFor="order-phone">
              {t('orders.shipTo.phone')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.required')})
              </span>
            </FieldLabel>
            <Input
              id="order-phone"
              type="tel"
              dir="ltr"
              maxLength={64}
              autoComplete="off"
              aria-required
              aria-invalid={!!errors.phone}
              aria-describedby={errors.phone ? 'order-phone-error' : 'order-phone-hint'}
              {...form.register('phone')}
            />
            {errors.phone ? (
              <FieldError id="order-phone-error">{message(errors.phone.message)}</FieldError>
            ) : (
              <FieldDescription id="order-phone-hint">{t('orders.new.phoneHint')}</FieldDescription>
            )}
          </Field>
          <Field data-invalid={!!errors.phoneAlt}>
            <FieldLabel htmlFor="order-phone-alt">
              {t('orders.shipTo.phoneAlt')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.optional')})
              </span>
            </FieldLabel>
            <Input
              id="order-phone-alt"
              type="tel"
              dir="ltr"
              maxLength={64}
              autoComplete="off"
              aria-invalid={!!errors.phoneAlt}
              aria-describedby={errors.phoneAlt ? 'order-phone-alt-error' : undefined}
              {...form.register('phoneAlt')}
            />
            <FieldError id="order-phone-alt-error">{message(errors.phoneAlt?.message)}</FieldError>
          </Field>
          <Field data-invalid={!!errors.address}>
            <FieldLabel htmlFor="order-address">
              {t('orders.shipTo.address')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.required')})
              </span>
            </FieldLabel>
            <Textarea
              id="order-address"
              rows={2}
              dir="auto"
              maxLength={500}
              aria-required
              aria-invalid={!!errors.address}
              aria-describedby={errors.address ? 'order-address-error' : undefined}
              {...form.register('address')}
            />
            <FieldError id="order-address-error">{message(errors.address?.message)}</FieldError>
          </Field>
          <Field className="md:col-span-2">
            <FieldLabel htmlFor="order-courier-note">
              {t('orders.shipTo.courierNote')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.optional')})
              </span>
            </FieldLabel>
            <Textarea
              id="order-courier-note"
              rows={2}
              dir="auto"
              maxLength={500}
              {...form.register('courierNote')}
            />
          </Field>
        </FieldGroup>
      </section>

      <section
        aria-labelledby="order-lines"
        className="flex flex-col gap-4 rounded-card gradient-card-edge p-4"
      >
        <h2 id="order-lines" className="text-base font-semibold">
          {t('orders.lines.title')}
        </h2>
        <ol className="flex flex-col gap-4">
          {lines.fields.map((line, index) => {
            const number = index + 1;
            const lineErrors = errors.lines?.[index];
            const skuError = lineErrors?.sku?.message;
            return (
              <li
                key={line.id}
                aria-label={t('orders.new.line', { number })}
                className={`grid items-start gap-3 border-b pb-4 last:border-b-0 last:pb-0 ${
                  gifted
                    ? 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]'
                    : 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]'
                }`}
              >
                <Field data-invalid={!!skuError}>
                  <FieldLabel htmlFor={`line-${index}-sku`}>{t('orders.lines.sku')}</FieldLabel>
                  <Controller
                    control={form.control}
                    name={`lines.${index}.sku`}
                    render={({ field }) => (
                      <SkuPicker
                        id={`line-${index}-sku`}
                        value={field.value}
                        placeholder={t('orders.new.chooseSku')}
                        onChange={(sku) => {
                          field.onChange(sku);
                          form.clearErrors(`lines.${index}.sku`);
                          // A list price starts the unit price, until the person types their own.
                          if (
                            sku.price &&
                            !form.getFieldState(`lines.${index}.unitPrice`).isDirty
                          ) {
                            form.setValue(`lines.${index}.unitPrice`, sku.price);
                          }
                        }}
                        onBlur={field.onBlur}
                        buttonRef={field.ref}
                        invalid={!!skuError}
                        describedBy={skuError ? `line-${index}-sku-error` : undefined}
                      />
                    )}
                  />
                  <FieldError id={`line-${index}-sku-error`}>{message(skuError)}</FieldError>
                </Field>

                <Field data-invalid={!!lineErrors?.quantity}>
                  <FieldLabel htmlFor={`line-${index}-quantity`}>
                    {t('orders.lines.quantity')}
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
                    {lineErrors?.quantity ? t('orders.new.errors.quantityInvalid') : null}
                  </FieldError>
                </Field>

                <Field data-invalid={!!lineErrors?.unitPrice}>
                  <FieldLabel htmlFor={`line-${index}-price`}>
                    {t('orders.lines.unitPrice')}
                  </FieldLabel>
                  <Input
                    id={`line-${index}-price`}
                    dir="ltr"
                    inputMode="decimal"
                    autoComplete="off"
                    className="tabular-nums"
                    aria-invalid={!!lineErrors?.unitPrice}
                    aria-describedby={
                      lineErrors?.unitPrice ? `line-${index}-price-error` : undefined
                    }
                    {...form.register(`lines.${index}.unitPrice`)}
                  />
                  <FieldError id={`line-${index}-price-error`}>
                    {lineErrors?.unitPrice
                      ? lineErrors.unitPrice.message === 'giftPriceRequired'
                        ? t('orders.new.errors.giftPriceRequired')
                        : t('orders.new.errors.amountInvalid')
                      : null}
                  </FieldError>
                </Field>

                {!gifted && (
                  <Field data-invalid={!!lineErrors?.discountAmount}>
                    <FieldLabel htmlFor={`line-${index}-discount`}>
                      {t('orders.lines.discount')}
                    </FieldLabel>
                    <Input
                      id={`line-${index}-discount`}
                      dir="ltr"
                      inputMode="decimal"
                      autoComplete="off"
                      className="tabular-nums"
                      aria-invalid={!!lineErrors?.discountAmount}
                      aria-describedby={
                        lineErrors?.discountAmount ? `line-${index}-discount-error` : undefined
                      }
                      {...form.register(`lines.${index}.discountAmount`)}
                    />
                    <FieldError id={`line-${index}-discount-error`}>
                      {lineErrors?.discountAmount ? t('orders.new.errors.amountInvalid') : null}
                    </FieldError>
                  </Field>
                )}

                <div className="flex md:pt-7">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="coarse:size-touch"
                    id={`line-${index}-remove`}
                    disabled={lines.fields.length === 1}
                    aria-label={t('orders.new.removeLine', { number })}
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
            id="order-add-line"
            disabled={lines.fields.length >= 100}
            onClick={() => {
              lines.append(NEW_LINE, { shouldFocus: false });
              focusTarget.current = { kind: 'new-line', index: lines.fields.length };
            }}
          >
            <PlusIcon aria-hidden data-icon="inline-start" />
            {t('orders.new.addLine')}
          </Button>
        </div>
        {gifted && <p className="text-sm text-muted-foreground">{t('orders.new.giftedNote')}</p>}
      </section>

      {!gifted && (
        <section
          aria-labelledby="order-shipping"
          className="flex flex-col gap-4 rounded-card gradient-card-edge p-4"
        >
          <h2 id="order-shipping" className="text-base font-semibold">
            {t('orders.new.shipping')}
          </h2>
          <FieldGroup className="grid gap-4 md:grid-cols-2">
            <Field data-invalid={!!errors.shippingChargedAmount}>
              <FieldLabel htmlFor="order-shipping-charge">{t('orders.money.shipping')}</FieldLabel>
              <Input
                id="order-shipping-charge"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                className="tabular-nums"
                aria-invalid={!!errors.shippingChargedAmount}
                aria-describedby={
                  errors.shippingChargedAmount ? 'order-shipping-charge-error' : undefined
                }
                {...form.register('shippingChargedAmount')}
              />
              <FieldError id="order-shipping-charge-error">
                {errors.shippingChargedAmount ? t('orders.new.errors.amountInvalid') : null}
              </FieldError>
            </Field>
          </FieldGroup>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <dl className="flex flex-wrap gap-6 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">{t('orders.money.total')}</dt>
            <dd className="font-medium tabular-nums">
              {total === null ? '' : format.money(total, 2)}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <Link href="/orders">{t('orders.new.cancel')}</Link>
          </Button>
          <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
            {mutation.isPending && (
              <LoaderCircleIcon
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            )}
            {t('orders.new.submit')}
          </Button>
        </div>
      </div>
    </form>
  );
}
