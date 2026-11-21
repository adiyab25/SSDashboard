'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AwaitingRestockCloseReason,
  CloseAwaitingRestockBody,
  quantityInput,
  type OrderDetail,
  type OrderLineView,
} from '@ssdashboard/contracts';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { useFormat } from '@/i18n/use-format';
import { SELECT_CLASS } from '@/shared/select-class';
import { useReturnFocus } from '@/shared/use-return-focus';
import { isStockOutOutOfDate, stockOutErrorKey } from './order-stock-out-errors';
import { closeAwaitingRestock, orderKeys } from './orders-api';

/** The form: how many pieces (typed in any digit set) and a reason from the list. */
const CloseForm = z.object({
  quantity: z.string(),
  reasonCode: z.string().min(1, 'reasonRequired'),
});
type CloseInput = z.input<typeof CloseForm>;
type CloseOutput = z.output<typeof CloseForm>;

/**
 * The form for pieces that never come back (spec 0013, AC-27 f): how many (1 up to what awaits)
 * and a reason code. A `stock.correct` holder closes them; anyone else sends the same form as a
 * request to a manager (`asRequest`), and the title, the explanation, and the button say "request"
 * so nobody believes the line changed. Sends the `updatedAt` of the order as the page showed it
 * when the dialog opened. A 409 `NOTHING_AWAITING` or `STALE_RECORD` refetches the order and says
 * so in the dialog. Never closes anything itself: the api decides.
 */
export function OrderCloseAwaitingDialog({
  order: opened,
  line,
  item,
  asRequest,
  onClose,
  onDone,
}: {
  /** The order as the page showed it when the dialog opened; later changes to it are ignored. */
  order: OrderDetail;
  line: OrderLineView;
  /** The line's name in the reader's language. */
  item: string;
  /** True for a warehouse hat: the api only records a request. */
  asRequest: boolean;
  onClose: () => void;
  /** Runs with the answered order and the quantity sent once the api says 200. */
  onDone: (answer: OrderDetail, quantity: number) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const returnFocus = useReturnFocus();
  const [order] = useState(opened);
  const max = line.awaitingRestockQuantity ?? 0;
  const form = useForm<CloseInput, unknown, CloseOutput>({
    resolver: zodResolver(CloseForm),
    mode: 'onTouched',
    defaultValues: { quantity: String(max), reasonCode: '' },
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (values: CloseOutput) => {
      const quantity = quantityInput({ min: 1, max }).parse(values.quantity);
      return closeAwaitingRestock(
        order.id,
        line.id,
        CloseAwaitingRestockBody.parse({
          expectedUpdatedAt: order.updatedAt,
          quantity,
          reasonCode: values.reasonCode,
        }),
      ).then((answer) => ({ answer, quantity }));
    },
    onSuccess: ({ answer, quantity }) => onDone(answer, quantity),
    onError: (error) => {
      if (isStockOutOutOfDate(error)) {
        void queryClient.invalidateQueries({ queryKey: orderKeys.all });
      }
      if (error instanceof ApiError && error.code === 'REASON_INVALID') {
        form.setFocus('reasonCode');
      }
    },
  });

  /** Checks the quantity against what awaits before anything is sent. */
  const submit = form.handleSubmit((values) => {
    if (!quantityInput({ min: 1, max }).safeParse(values.quantity).success) {
      form.setError('quantity', { message: 'quantityInvalid' });
      form.setFocus('quantity');
      return;
    }
    mutation.mutate(values);
  });

  const failed = mutation.error;
  const reasonProblem = errors.reasonCode ? t('orders.stockOut.reasonRequired') : null;
  const quantityProblem = errors.quantity
    ? t('orders.stockOut.quantityInvalid', { max: format.quantity(max) })
    : null;

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('orders.stockOut.closeDialogClose')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-lg"
      >
        <form noValidate className="grid gap-6" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>
              {t(asRequest ? 'orders.stockOut.requestTitle' : 'orders.stockOut.closeTitle')}
            </DialogTitle>
            <DialogDescription>
              {t(
                asRequest
                  ? 'orders.stockOut.requestDescription'
                  : 'orders.stockOut.closeDescription',
                { item },
              )}
            </DialogDescription>
          </DialogHeader>

          {failed && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(stockOutErrorKey(failed))}</AlertDescription>
            </Alert>
          )}

          <Field data-invalid={!!quantityProblem}>
            <FieldLabel htmlFor="awaiting-close-quantity">
              {t('orders.stockOut.quantity')}
            </FieldLabel>
            <Input
              id="awaiting-close-quantity"
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              className="tabular-nums"
              aria-invalid={!!quantityProblem}
              aria-describedby={
                quantityProblem ? 'awaiting-close-quantity-error' : 'awaiting-close-quantity-hint'
              }
              {...form.register('quantity')}
            />
            <FieldDescription id="awaiting-close-quantity-hint">
              {t('orders.stockOut.quantityHint', { max: format.quantity(max) })}
            </FieldDescription>
            <FieldError id="awaiting-close-quantity-error">{quantityProblem}</FieldError>
          </Field>

          <Field data-invalid={!!reasonProblem}>
            <FieldLabel htmlFor="awaiting-close-reason">{t('orders.stockOut.reason')}</FieldLabel>
            <select
              id="awaiting-close-reason"
              className={SELECT_CLASS}
              aria-required
              aria-invalid={!!reasonProblem}
              aria-describedby={reasonProblem ? 'awaiting-close-reason-error' : undefined}
              {...form.register('reasonCode')}
            >
              <option value="">{t('orders.stockOut.chooseReason')}</option>
              {AwaitingRestockCloseReason.options.map((code) => (
                <option key={code} value={code}>
                  {t(`orders.stockOut.reasons.close.${code}`)}
                </option>
              ))}
            </select>
            <FieldError id="awaiting-close-reason-error">{reasonProblem}</FieldError>
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t('orders.stockOut.keep')}
            </Button>
            <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t(asRequest ? 'orders.stockOut.submitRequest' : 'orders.stockOut.submitClose')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
