'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { VoidStockReceiptRequest, type StockReceiptDetail } from '@ssdashboard/contracts';
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
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ApiError } from '@/api/client';
import { inventoryKeys, voidReceipt } from './inventory-api';
import { useReturnFocus } from '@/shared/use-return-focus';

type VoidInput = z.input<typeof VoidStockReceiptRequest>;
type VoidOutput = z.output<typeof VoidStockReceiptRequest>;

const KNOWN = new Set(['ALREADY_VOIDED', 'INSUFFICIENT_STOCK', 'BUSY', 'LOCK_DATE_UNREADABLE']);

/**
 * Confirms a void (spec 0006, AC-8): the reason is required, the destructive button names the
 * action, and Cancel closes. Admins only; the api enforces it too.
 */
export function VoidReceiptDialog({
  receipt,
  onClose,
}: {
  receipt: StockReceiptDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const form = useForm<VoidInput, unknown, VoidOutput>({
    resolver: zodResolver(VoidStockReceiptRequest),
    mode: 'onTouched',
    defaultValues: { reason: '' },
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (values: VoidOutput) => voidReceipt(receipt.id, values.reason),
    onSuccess: (voided) => {
      queryClient.setQueryData(inventoryKeys.receipt(voided.id), voided);
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.stockAll });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.receiptsAll });
      toast.success(t('inventory.void.voided', { number: voided.number }));
      onClose();
    },
    onError: (error) => {
      // Someone else voided it meanwhile: show the stored state behind the dialog.
      if (error instanceof ApiError && error.code === 'ALREADY_VOIDED') {
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.receipt(receipt.id) });
      }
    },
  });

  const error = mutation.error;
  const code = error instanceof ApiError && KNOWN.has(error.code) ? error.code : null;
  const short = (error instanceof ApiError ? (error.body.skuIds ?? []) : [])
    .map((id) => receipt.lines.find((line) => line.sku.id === id)?.sku.code ?? id)
    .join(', ');
  const failure = !error
    ? null
    : code === 'INSUFFICIENT_STOCK'
      ? t('inventory.void.errors.INSUFFICIENT_STOCK', { skus: short })
      : code === 'ALREADY_VOIDED'
        ? t('inventory.void.errors.ALREADY_VOIDED')
        : code === 'BUSY'
          ? t('inventory.void.errors.BUSY')
          : code === 'LOCK_DATE_UNREADABLE'
            ? t('inventory.void.errors.LOCK_DATE_UNREADABLE')
            : t('inventory.void.errors.generic');

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('inventory.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-lg"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => void form.handleSubmit((values) => mutation.mutate(values))(event)}
        >
          <DialogHeader>
            <DialogTitle>{t('inventory.void.title', { number: receipt.number })}</DialogTitle>
            <DialogDescription>{t('inventory.void.description')}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}

          <Field data-invalid={!!errors.reason}>
            <FieldLabel htmlFor="void-reason">
              {t('inventory.void.reason')}
              <span className="font-normal text-muted-foreground">({t('inventory.required')})</span>
            </FieldLabel>
            <Textarea
              id="void-reason"
              rows={3}
              maxLength={500}
              aria-required
              aria-invalid={!!errors.reason}
              aria-describedby={errors.reason ? 'void-reason-error' : 'void-reason-hint'}
              {...form.register('reason')}
            />
            {errors.reason ? (
              <FieldError id="void-reason-error">
                {t('inventory.void.errors.reasonRequired')}
              </FieldError>
            ) : (
              <FieldDescription id="void-reason-hint">
                {t('inventory.void.reasonHint')}
              </FieldDescription>
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t('inventory.cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={mutation.isPending || code === 'ALREADY_VOIDED'}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('inventory.void.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
