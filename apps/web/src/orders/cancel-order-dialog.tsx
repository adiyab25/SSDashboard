'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CancelOrderBody,
  CancelReasonCode,
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
import { Field, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { useMutation } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { useReturnFocus } from '@/shared/use-return-focus';
import { SELECT_CLASS } from './order-field-classes';
import {
  isCancelInShopify,
  isOutOfDate,
  isStaleAnswer,
  orderWriteErrorKey,
} from './order-write-errors';
import { cancelOrder } from './orders-api';
import { RelatedOrderPicker } from './related-order-picker';

/** The form: a reason from the list, and for `duplicate` the order it duplicates. */
const CancelForm = z
  .object({
    reasonCode: z.string().min(1, 'reasonRequired'),
    duplicateOf: z
      .object({ id: z.string(), storeCode: z.string(), orderNumber: z.string() })
      .nullable(),
  })
  .superRefine((form, context) => {
    if (form.reasonCode !== '' && !CancelReasonCode.safeParse(form.reasonCode).success) {
      context.addIssue({ code: 'custom', path: ['reasonCode'], message: 'reasonRequired' });
    }
    if (form.reasonCode === 'duplicate' && form.duplicateOf === null) {
      context.addIssue({ code: 'custom', path: ['duplicateOf'], message: 'duplicateRequired' });
    }
  });
type CancelInput = z.input<typeof CancelForm>;
type CancelOutput = z.output<typeof CancelForm>;

/** Codes whose sentence belongs under a field, not in the alert. */
const REASON_CODES = new Set(['REASON_INVALID']);
const TARGET_CODES = new Set(['DUPLICATE_TARGET_REQUIRED']);

/**
 * The cancel dialog (spec 0013, AC-7): a reason from the cancel list, and for `duplicate` the order
 * it duplicates, found by the same phone or number search the new order form uses. A cancel keeps
 * every line and total as it was, so the dialog says so before the destructive button. Sends the
 * `updatedAt` the page showed. Errors show from the api's stable code; `CANCEL_IN_SHOPIFY` and a
 * stale order hand back to the page (`onInShopify`, `onStale`). Focus returns to the Cancel button
 * on close. Never cancels anything itself: the api decides.
 */
export function CancelOrderDialog({
  order: opened,
  onClose,
  onCancelled,
  onInShopify,
  onStale,
  onOutOfDate,
  onRestoreFocus,
}: {
  /** The order as the page showed it when the person opened the dialog; later changes to it are ignored. */
  order: OrderDetail;
  onClose: () => void;
  /** Runs with the answered order once the api says 200. */
  onCancelled: (answer: OrderDetail) => void;
  /** The api says this Shopify order is cancelled in Shopify. */
  onInShopify: () => void;
  /** The order changed since the page loaded. */
  onStale: () => void;
  /** The order is locked, no longer in the expected state, or gone: refetch it. */
  onOutOfDate: () => void;
  /** Puts focus on a control that still exists, when the one that opened the dialog is gone. */
  onRestoreFocus: () => void;
}) {
  const { t } = useTranslation();
  // The dialog keeps the order it opened on, so a refetch behind it cannot give a fresh token.
  const [order] = useState(opened);
  const returnFocus = useReturnFocus();
  const form = useForm<CancelInput, unknown, CancelOutput>({
    resolver: zodResolver(CancelForm),
    mode: 'onTouched',
    defaultValues: { reasonCode: '', duplicateOf: null },
  });
  const { errors } = form.formState;
  const reason = useWatch({ control: form.control, name: 'reasonCode' });

  const mutation = useMutation({
    mutationFn: (values: CancelOutput) =>
      cancelOrder(
        order.id,
        CancelOrderBody.parse({
          expectedUpdatedAt: order.updatedAt,
          reasonCode: values.reasonCode,
          ...(values.reasonCode === 'duplicate' && { duplicateOfOrderId: values.duplicateOf?.id }),
        }),
      ),
    onSuccess: onCancelled,
    onError: (error) => {
      if (isStaleAnswer(error)) onStale();
      else if (isOutOfDate(error)) onOutOfDate();
      else if (isCancelInShopify(error)) onInShopify();
      else if (error instanceof ApiError && REASON_CODES.has(error.code)) {
        form.setFocus('reasonCode');
      } else if (error instanceof ApiError && TARGET_CODES.has(error.code)) {
        form.setFocus('duplicateOf');
      }
    },
  });

  const failed = mutation.error;
  const failedCode = failed instanceof ApiError ? failed.code : null;
  const reasonProblem = errors.reasonCode
    ? t('orders.cancel.reasonRequired')
    : failedCode && REASON_CODES.has(failedCode)
      ? t(orderWriteErrorKey(failed))
      : null;
  const targetProblem =
    reason !== 'duplicate'
      ? null
      : errors.duplicateOf
        ? t('orders.cancel.duplicateRequired')
        : failedCode && TARGET_CODES.has(failedCode)
          ? t(orderWriteErrorKey(failed))
          : null;
  const alertKey: MessageKey | null =
    failed && !reasonProblem && !targetProblem ? orderWriteErrorKey(failed) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('orders.cancel.close')}
        onCloseAutoFocus={(event) => {
          returnFocus(event);
          if (!event.defaultPrevented) {
            event.preventDefault();
            onRestoreFocus();
          }
        }}
        className="sm:max-w-lg"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => void form.handleSubmit((values) => mutation.mutate(values))(event)}
        >
          <DialogHeader>
            <DialogTitle>
              {t('orders.cancel.title', { order: `⁦${orderLabelOf(order)}⁩` })}
            </DialogTitle>
            <DialogDescription>{t('orders.cancel.description')}</DialogDescription>
          </DialogHeader>

          {alertKey && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(alertKey)}</AlertDescription>
            </Alert>
          )}

          <Field data-invalid={!!reasonProblem}>
            <FieldLabel htmlFor="cancel-reason">
              {t('orders.cancel.reason')}
              <span className="font-normal text-muted-foreground">
                ({t('orders.new.required')})
              </span>
            </FieldLabel>
            <select
              id="cancel-reason"
              className={SELECT_CLASS}
              aria-required
              aria-invalid={!!reasonProblem}
              aria-describedby={reasonProblem ? 'cancel-reason-error' : undefined}
              {...form.register('reasonCode')}
            >
              <option value="">{t('orders.cancel.chooseReason')}</option>
              {CancelReasonCode.options.map((code) => (
                <option key={code} value={code}>
                  {t(`orders.reasons.cancel.${code}`)}
                </option>
              ))}
            </select>
            <FieldError id="cancel-reason-error">{reasonProblem}</FieldError>
          </Field>

          {reason === 'duplicate' && (
            <Field data-invalid={!!targetProblem}>
              <FieldLabel htmlFor="cancel-duplicate-of">
                {t('orders.cancel.duplicateOf')}
                <span className="font-normal text-muted-foreground">
                  ({t('orders.new.required')})
                </span>
              </FieldLabel>
              <Controller
                control={form.control}
                name="duplicateOf"
                render={({ field }) => (
                  <RelatedOrderPicker
                    id="cancel-duplicate-of"
                    excludeId={order.id}
                    value={field.value}
                    onChange={(picked) => {
                      field.onChange(picked);
                      form.clearErrors('duplicateOf');
                    }}
                    onBlur={field.onBlur}
                    buttonRef={field.ref}
                    invalid={!!targetProblem}
                    describedBy={targetProblem ? 'cancel-duplicate-of-error' : undefined}
                  />
                )}
              />
              <FieldError id="cancel-duplicate-of-error">{targetProblem}</FieldError>
            </Field>
          )}

          <p className="text-sm text-muted-foreground">{t('orders.cancel.keepsLines')}</p>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t('orders.cancel.keep')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={mutation.isPending}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('orders.cancel.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
