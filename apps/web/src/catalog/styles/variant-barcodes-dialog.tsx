'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { BarcodeCode, type SkuBarcode, type StyleVariant } from '@ssdashboard/contracts';
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
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { inventoryKeys } from '@/inventory/inventory-api';
import { useReturnFocus } from '@/shared/use-return-focus';
import { addBarcode, catalogKeys, removeBarcode } from '../catalog-api';
import { barcodeHolder, catalogErrorCode } from '../catalog-error';

/** The add form: one barcode, checked and normalized by the contract (AC-10). */
const BarcodeForm = z.object({ code: BarcodeCode });
type FormInput = z.input<typeof BarcodeForm>;
type FormOutput = z.output<typeof BarcodeForm>;

const KNOWN = ['BARCODE_TAKEN', 'INVALID_INPUT', 'NOT_FOUND'] as const;
type Failure = Exclude<(typeof KNOWN)[number], 'BARCODE_TAKEN'> | 'generic';
/** What removing a barcode can answer besides success. */
const REMOVE_KNOWN = ['NOT_FOUND'] as const;

/** Props of `VariantBarcodesDialog`. */
interface Props {
  styleId: string;
  variant: StyleVariant;
  onClose: () => void;
}

/**
 * The barcodes of one SKU on the style page (spec 0012, AC-10, `catalog.edit`): the list with a
 * Remove button per barcode, and a field to add one. A barcode another SKU holds is refused with
 * that SKU's code in the message. Each write refreshes the style and the SKU queries with
 * `refetchAfterWrite`; the list here follows the api's answers so it never waits on the refetch.
 */
export function VariantBarcodesDialog({ styleId, variant, onClose }: Props) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const [barcodes, setBarcodes] = useState<SkuBarcode[]>(variant.barcodes);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [holder, setHolder] = useState<string | undefined>();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(BarcodeForm),
    mode: 'onSubmit',
    defaultValues: { code: '' },
  });
  const { errors } = form.formState;

  const refresh = () => {
    void refetchAfterWrite(queryClient, { queryKey: catalogKeys.style(styleId) });
    void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.skus });
  };

  const add = useMutation({
    mutationFn: (values: FormOutput) => addBarcode(variant.id, { code: values.code }),
    onSuccess: (sku, values) => {
      setBarcodes(sku.barcodes);
      refresh();
      form.reset({ code: '' });
      toast.success(t('catalog.barcodes.added', { code: values.code }));
    },
    onError: (error) => {
      const code = catalogErrorCode(error, KNOWN);
      if (code === 'BARCODE_TAKEN') {
        setHolder(barcodeHolder(error));
        form.setError('code', { message: 'taken' }, { shouldFocus: true });
        return;
      }
      setFailure(code);
    },
  });

  /** Drops a row and moves focus to the next Remove button, else to the new barcode field. */
  const dropRow = (barcode: SkuBarcode) => {
    const next = barcodes[barcodes.findIndex((item) => item.id === barcode.id) + 1];
    setBarcodes((current) => current.filter((item) => item.id !== barcode.id));
    window.requestAnimationFrame(() =>
      (
        (next ? document.getElementById(`barcode-remove-${next.id}`) : null) ??
        document.getElementById('barcode-new')
      )?.focus(),
    );
  };

  const remove = useMutation({
    mutationFn: (barcode: SkuBarcode) => removeBarcode(variant.id, barcode.id),
    onSuccess: (_result, barcode) => {
      dropRow(barcode);
      refresh();
      toast.success(t('catalog.barcodes.removed', { code: barcode.code }));
    },
    onError: (error, barcode) => {
      const code = catalogErrorCode(error, REMOVE_KNOWN);
      // The barcode is already gone: show the truth and refresh the lists behind.
      if (code === 'NOT_FOUND') {
        dropRow(barcode);
        refresh();
      }
      setFailure(code);
    },
  });

  const pending = add.isPending || remove.isPending;
  const taken = errors.code?.message === 'taken';

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('catalog.common.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t('catalog.barcodes.title', { code: variant.code })}</DialogTitle>
          <DialogDescription>{t('catalog.barcodes.description')}</DialogDescription>
        </DialogHeader>

        {failure && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{t(`catalog.barcodes.errors.${failure}`)}</AlertDescription>
          </Alert>
        )}

        {barcodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('catalog.barcodes.none')}</p>
        ) : (
          <ul aria-label={t('catalog.barcodes.listLabel')} className="flex flex-col divide-y">
            {barcodes.map((barcode) => (
              <li key={barcode.id} className="flex h-row items-center justify-between gap-3">
                <LtrText className="font-medium">{barcode.code}</LtrText>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={pending}
                  id={`barcode-remove-${barcode.id}`}
                  aria-label={t('catalog.barcodes.removeLabel', { code: barcode.code })}
                  onClick={() => {
                    setFailure(null);
                    remove.mutate(barcode);
                  }}
                >
                  {t('catalog.barcodes.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          noValidate
          className="grid gap-2"
          onSubmit={(event) => {
            setFailure(null);
            void form.handleSubmit((values) => add.mutate(values))(event);
          }}
        >
          <Field data-invalid={!!errors.code}>
            <FieldLabel htmlFor="barcode-new">{t('catalog.barcodes.code')}</FieldLabel>
            <div className="flex flex-wrap items-start gap-2">
              <Input
                id="barcode-new"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                className="min-w-40 flex-1"
                aria-invalid={!!errors.code}
                aria-describedby={errors.code ? 'barcode-new-error' : 'barcode-new-hint'}
                {...form.register('code')}
              />
              <Button type="submit" variant="outline" disabled={pending} aria-busy={add.isPending}>
                {add.isPending && (
                  <LoaderCircleIcon
                    aria-hidden
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                  />
                )}
                {t('catalog.barcodes.add')}
              </Button>
            </div>
            {errors.code ? (
              <FieldError id="barcode-new-error">
                {taken
                  ? holder
                    ? t('catalog.barcodes.errors.BARCODE_TAKEN', { sku: holder })
                    : t('catalog.barcodes.errors.BARCODE_TAKEN_OTHER')
                  : t('catalog.barcodes.codeInvalid')}
              </FieldError>
            ) : (
              <FieldDescription id="barcode-new-hint">
                {t('catalog.barcodes.codeHint')}
              </FieldDescription>
            )}
          </Field>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {t('catalog.common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
