'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  EditReasonCode,
  LineRemovalReasonCode,
  OrderEditBody,
  orderLabelOf,
  type OrderDetail,
} from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ssdashboard/ui/components/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { LoaderCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { ApiError } from '@/api/client';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { useReturnFocus } from '@/shared/use-return-focus';
import { SELECT_CLASS } from './order-field-classes';
import {
  buildEditBody,
  editDefaultsOf,
  NEW_EDIT_LINE,
  openLinesOf,
  orderEditFormOf,
  type OrderEditInput,
  type OrderEditOutput,
} from './order-edit-form';
import { OrderEditLineFields } from './order-edit-line-fields';
import { isEditInShopify, isStaleAnswer, orderWriteErrorKey } from './order-write-errors';
import { editOrder } from './orders-api';

/** Codes whose sentence belongs under a field, not in the alert. */
const FIELD_CODES: Record<string, 'phone' | 'phoneAlt' | 'reasonCode'> = {
  INVALID_PHONE: 'phone',
  INVALID_PHONE_ALT: 'phoneAlt',
  REASON_INVALID: 'reasonCode',
};

/** The most rows a person can add in one edit, so the body stays inside the contract's 50 operations. */
const MAX_ADDED = 20;

/**
 * The edit dialog (spec 0013, AC-9, AC-10, AC-2): the ship to fields, every open line (keep it,
 * replace it with another SKU, quantity, or price, or remove it with a reason), rows to add, the
 * shipping charge, and an optional reason, all applied in one edit. Only what changed is sent,
 * with the `updatedAt` the page showed. A gifted order's lines and shipping need `orders.gift`
 * (without it only the ship to block shows) and its lines keep their price with an equal discount.
 * Errors show from the api's stable code, under the field where one applies; `EDIT_IN_SHOPIFY`
 * and a stale order hand back to the page (`onInShopify`, `onStale`). Focus returns to the Edit
 * button on close. Never decides what an edit may do: the api checks every rule again.
 */
export function OrderEditDialog({
  order,
  onClose,
  onEdited,
  onInShopify,
  onStale,
}: {
  /** The order as the page shows it now. */
  order: OrderDetail;
  onClose: () => void;
  /** Runs with the answered order once the api says 200. */
  onEdited: (answer: OrderDetail) => void;
  /** The api says this Shopify order is edited in Shopify. */
  onInShopify: () => void;
  /** The order changed since the page loaded. */
  onStale: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const access = useAccess();
  const returnFocus = useReturnFocus();
  const gifted = order.type === 'gifted';
  const mayChangeLines = !gifted || access.can('orders.gift');
  const open = useMemo(() => openLinesOf(order), [order]);
  const schema = useMemo(() => orderEditFormOf(order), [order]);
  const [nothingChanged, setNothingChanged] = useState(false);

  const form = useForm<OrderEditInput, unknown, OrderEditOutput>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: editDefaultsOf(order),
  });
  const { errors } = form.formState;
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const watched = useWatch({ control: form.control, name: 'lines' });
  const focusRow = useRef<number | null>(null);

  // A row a person just added takes focus on its SKU picker.
  useEffect(() => {
    const row = focusRow.current;
    if (row === null) return;
    focusRow.current = null;
    document.getElementById(`edit-line-${row}-sku`)?.focus();
  }, [lines.fields.length]);

  const mutation = useMutation({
    mutationFn: (body: OrderEditBody) => editOrder(order.id, OrderEditBody.parse(body)),
    onSuccess: onEdited,
    onError: (error) => {
      if (isStaleAnswer(error)) onStale();
      else if (isEditInShopify(error)) onInShopify();
      else if (error instanceof ApiError && FIELD_CODES[error.code]) {
        form.setFocus(FIELD_CODES[error.code] ?? 'phone');
      }
    },
  });

  function submit(values: OrderEditOutput) {
    const body = buildEditBody(order, values, { gifted, mayChangeLines });
    if (body.operations.length === 0) {
      setNothingChanged(true);
      return;
    }
    setNothingChanged(false);
    mutation.mutate(body);
  }

  const failed = mutation.error;
  const failedCode = failed instanceof ApiError ? failed.code : null;
  const failedField = failedCode ? FIELD_CODES[failedCode] : undefined;
  const fieldProblem = (field: 'phone' | 'phoneAlt' | 'reasonCode') =>
    failedField === field && failed ? t(orderWriteErrorKey(failed)) : null;
  const alertKey: MessageKey | null = nothingChanged
    ? 'orders.edit.nothingChanged'
    : failed && !failedField
      ? orderWriteErrorKey(failed)
      : null;
  const requiredText = t('orders.new.errors.required');

  return (
    <Dialog open onOpenChange={(next) => !next && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('orders.edit.close')}
        onCloseAutoFocus={returnFocus}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => void form.handleSubmit(submit)(event)}
        >
          <DialogHeader>
            <DialogTitle>
              {t('orders.edit.title', { order: `⁦${orderLabelOf(order)}⁩` })}
            </DialogTitle>
            <DialogDescription>{t('orders.edit.description')}</DialogDescription>
          </DialogHeader>

          {alertKey && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(alertKey)}</AlertDescription>
            </Alert>
          )}

          <section aria-labelledby="edit-ship-to" className="flex flex-col gap-4">
            <h3 id="edit-ship-to" className="text-base font-semibold">
              {t('orders.shipTo.title')}
            </h3>
            <FieldGroup className="grid gap-4 md:grid-cols-2">
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="edit-name">{t('orders.shipTo.name')}</FieldLabel>
                <Input
                  id="edit-name"
                  dir="auto"
                  maxLength={200}
                  autoComplete="off"
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? 'edit-name-error' : undefined}
                  {...form.register('name')}
                />
                <FieldError id="edit-name-error">{errors.name ? requiredText : null}</FieldError>
              </Field>
              <Field data-invalid={!!errors.phone || !!fieldProblem('phone')}>
                <FieldLabel htmlFor="edit-phone">{t('orders.shipTo.phone')}</FieldLabel>
                <Input
                  id="edit-phone"
                  type="tel"
                  dir="ltr"
                  maxLength={64}
                  autoComplete="off"
                  aria-invalid={!!errors.phone || !!fieldProblem('phone')}
                  aria-describedby={
                    errors.phone || fieldProblem('phone') ? 'edit-phone-error' : 'edit-phone-hint'
                  }
                  {...form.register('phone')}
                />
                {errors.phone || fieldProblem('phone') ? (
                  <FieldError id="edit-phone-error">
                    {errors.phone ? requiredText : fieldProblem('phone')}
                  </FieldError>
                ) : (
                  <FieldDescription id="edit-phone-hint">
                    {order.shipTo.contactPhoneRaw ? (
                      <>
                        {t('orders.shipTo.phoneAsTyped')}:{' '}
                        <LtrText>{order.shipTo.contactPhoneRaw}</LtrText>
                      </>
                    ) : (
                      t('orders.new.phoneHint')
                    )}
                  </FieldDescription>
                )}
              </Field>
              <Field data-invalid={!!fieldProblem('phoneAlt')}>
                <FieldLabel htmlFor="edit-phone-alt">{t('orders.shipTo.phoneAlt')}</FieldLabel>
                <Input
                  id="edit-phone-alt"
                  type="tel"
                  dir="ltr"
                  maxLength={64}
                  autoComplete="off"
                  aria-invalid={!!fieldProblem('phoneAlt')}
                  aria-describedby={fieldProblem('phoneAlt') ? 'edit-phone-alt-error' : undefined}
                  {...form.register('phoneAlt')}
                />
                <FieldError id="edit-phone-alt-error">{fieldProblem('phoneAlt')}</FieldError>
              </Field>
              <Field data-invalid={!!errors.address}>
                <FieldLabel htmlFor="edit-address">{t('orders.shipTo.address')}</FieldLabel>
                <Textarea
                  id="edit-address"
                  rows={2}
                  dir="auto"
                  maxLength={500}
                  aria-invalid={!!errors.address}
                  aria-describedby={errors.address ? 'edit-address-error' : undefined}
                  {...form.register('address')}
                />
                <FieldError id="edit-address-error">
                  {errors.address ? requiredText : null}
                </FieldError>
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel htmlFor="edit-courier-note">
                  {t('orders.shipTo.courierNote')}
                </FieldLabel>
                <Textarea
                  id="edit-courier-note"
                  rows={2}
                  dir="auto"
                  maxLength={500}
                  {...form.register('courierNote')}
                />
              </Field>
            </FieldGroup>
          </section>

          {mayChangeLines ? (
            <section aria-labelledby="edit-lines" className="flex flex-col gap-4">
              <h3 id="edit-lines" className="text-base font-semibold">
                {t('orders.lines.title')}
              </h3>
              <ol className="flex flex-col gap-4">
                {lines.fields.map((line, index) => {
                  const added = index >= open.length;
                  const source = open[index];
                  const action = watched?.[index]?.action ?? line.action;
                  const prefix = `edit-line-${index}`;
                  return (
                    <li
                      key={line.id}
                      aria-label={
                        added
                          ? t('orders.edit.addedLine', { number: index - open.length + 1 })
                          : t('orders.new.line', { number: index + 1 })
                      }
                      className="flex flex-col gap-3 border-b pb-4 last:border-b-0 last:pb-0"
                    >
                      {added ? (
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium">{t('orders.edit.newLine')}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="coarse:size-touch"
                            aria-label={t('orders.edit.removeAdded', {
                              number: index - open.length + 1,
                            })}
                            onClick={() => {
                              lines.remove(index);
                              document.getElementById('edit-add-line')?.focus();
                            }}
                          >
                            <Trash2Icon aria-hidden />
                          </Button>
                        </div>
                      ) : (
                        source && (
                          <div className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
                            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                              {source.skuCode && (
                                <LtrText className="font-medium">{source.skuCode}</LtrText>
                              )}
                              <bdi dir="auto" className="truncate text-muted-foreground">
                                {text(source.name ?? {}, source.title)}
                              </bdi>
                              <span className="tabular-nums text-muted-foreground">
                                {source.quantity} × {format.money(source.unitPrice, 2)}
                              </span>
                            </p>
                            <Field data-invalid={false}>
                              <FieldLabel htmlFor={`${prefix}-action`}>
                                {t('orders.edit.lineAction', { number: index + 1 })}
                              </FieldLabel>
                              <select
                                id={`${prefix}-action`}
                                className={SELECT_CLASS}
                                {...form.register(`lines.${index}.action`)}
                              >
                                <option value="keep">{t('orders.edit.actions.keep')}</option>
                                <option value="replace">{t('orders.edit.actions.replace')}</option>
                                <option value="remove">{t('orders.edit.actions.remove')}</option>
                              </select>
                            </Field>
                          </div>
                        )
                      )}

                      {action === 'remove' && (
                        <Field data-invalid={!!errors.lines?.[index]?.removalReason}>
                          <FieldLabel htmlFor={`${prefix}-removal`}>
                            {t('orders.edit.removalReason')}
                            <span className="font-normal text-muted-foreground">
                              ({t('orders.new.required')})
                            </span>
                          </FieldLabel>
                          <select
                            id={`${prefix}-removal`}
                            className={SELECT_CLASS}
                            aria-required
                            aria-invalid={!!errors.lines?.[index]?.removalReason}
                            aria-describedby={
                              errors.lines?.[index]?.removalReason
                                ? `${prefix}-removal-error`
                                : undefined
                            }
                            {...form.register(`lines.${index}.removalReason`)}
                          >
                            <option value="">{t('orders.edit.chooseRemovalReason')}</option>
                            {LineRemovalReasonCode.options.map((code) => (
                              <option key={code} value={code}>
                                {t(`orders.reasons.lineRemoval.${code}`)}
                              </option>
                            ))}
                          </select>
                          <FieldError id={`${prefix}-removal-error`}>
                            {errors.lines?.[index]?.removalReason
                              ? t('orders.edit.removalReasonRequired')
                              : null}
                          </FieldError>
                        </Field>
                      )}

                      {(action === 'replace' || action === 'add') && (
                        <OrderEditLineFields
                          form={form}
                          index={index}
                          gifted={gifted}
                          prefix={prefix}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  id="edit-add-line"
                  disabled={lines.fields.length - open.length >= MAX_ADDED}
                  onClick={() => {
                    focusRow.current = lines.fields.length;
                    lines.append(NEW_EDIT_LINE, { shouldFocus: false });
                  }}
                >
                  <PlusIcon aria-hidden data-icon="inline-start" />
                  {t('orders.new.addLine')}
                </Button>
              </div>
              {gifted && (
                <p className="text-sm text-muted-foreground">{t('orders.new.giftedNote')}</p>
              )}
            </section>
          ) : (
            <p className="rounded-lg border p-3 text-sm text-muted-foreground">
              {t('orders.edit.giftLinesNeedPermission')}
            </p>
          )}

          {mayChangeLines && !gifted && (
            <section aria-labelledby="edit-shipping" className="flex flex-col gap-4">
              <h3 id="edit-shipping" className="text-base font-semibold">
                {t('orders.new.shipping')}
              </h3>
              <FieldGroup className="grid gap-4 md:grid-cols-2">
                <Field data-invalid={!!errors.shippingChargedAmount}>
                  <FieldLabel htmlFor="edit-shipping-charge">
                    {t('orders.money.shipping')}
                  </FieldLabel>
                  <Input
                    id="edit-shipping-charge"
                    dir="ltr"
                    inputMode="decimal"
                    autoComplete="off"
                    className="tabular-nums"
                    aria-invalid={!!errors.shippingChargedAmount}
                    aria-describedby={
                      errors.shippingChargedAmount ? 'edit-shipping-charge-error' : undefined
                    }
                    {...form.register('shippingChargedAmount')}
                  />
                  <FieldError id="edit-shipping-charge-error">
                    {errors.shippingChargedAmount ? t('orders.new.errors.amountInvalid') : null}
                  </FieldError>
                </Field>
              </FieldGroup>
            </section>
          )}

          <Field data-invalid={!!errors.reasonCode || !!fieldProblem('reasonCode')}>
            <FieldLabel htmlFor="edit-reason">
              {t('orders.edit.reason')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.optional')})
              </span>
            </FieldLabel>
            <select
              id="edit-reason"
              className={SELECT_CLASS}
              aria-invalid={!!errors.reasonCode || !!fieldProblem('reasonCode')}
              aria-describedby={
                errors.reasonCode || fieldProblem('reasonCode') ? 'edit-reason-error' : undefined
              }
              {...form.register('reasonCode')}
            >
              <option value="">{t('orders.edit.noReason')}</option>
              {EditReasonCode.options.map((code) => (
                <option key={code} value={code}>
                  {t(`orders.reasons.edit.${code}`)}
                </option>
              ))}
            </select>
            <FieldError id="edit-reason-error">
              {errors.reasonCode
                ? t('orders.new.errors.REASON_INVALID')
                : fieldProblem('reasonCode')}
            </FieldError>
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t('orders.edit.cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('orders.edit.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
