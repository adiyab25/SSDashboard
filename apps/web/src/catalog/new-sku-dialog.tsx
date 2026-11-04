'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PriceString, SkuCode, type SkuDetail } from '@ssdashboard/contracts';
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import type { MessageKey } from '@/i18n/message-key';
import { createSku, inventoryKeys } from '@/inventory/inventory-api';
import { useReturnFocus } from '@/inventory/use-return-focus';

/** The form, built from the contract's field schemas (spec 0006, AC-1). */
const NewSkuForm = z
  .object({
    code: SkuCode,
    nameEn: z.string().trim().max(200),
    nameAr: z.string().trim().max(200),
    price: z.union([z.literal(''), z.string().trim().pipe(PriceString)]),
  })
  .refine((form) => form.nameEn !== '' || form.nameAr !== '', {
    path: ['nameEn'],
    message: 'nameRequired',
  });
type NewSkuInput = z.input<typeof NewSkuForm>;
type NewSkuOutput = z.output<typeof NewSkuForm>;

const EMPTY: NewSkuInput = { code: '', nameEn: '', nameAr: '', price: '' };

interface Props {
  onClose: () => void;
  onCreated?: (sku: SkuDetail) => void;
}

/** Creates one SKU (a product with one stocked variant). Any signed in person. */
export function NewSkuDialog({ onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const form = useForm<NewSkuInput, unknown, NewSkuOutput>({
    resolver: zodResolver(NewSkuForm),
    mode: 'onTouched',
    defaultValues: EMPTY,
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (values: NewSkuOutput) =>
      createSku({
        name: { en: values.nameEn, ar: values.nameAr },
        variants: [{ sku: values.code, price: values.price === '' ? null : values.price }],
      }),
    onSuccess: (sku) => {
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.skus });
      toast.success(t('inventory.sku.created', { code: sku.code }));
      onCreated?.(sku);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'SKU_TAKEN') {
        form.setError('code', { message: 'SKU_TAKEN' }, { shouldFocus: true });
      }
    },
  });

  const failed =
    mutation.error && !(mutation.error instanceof ApiError && mutation.error.code === 'SKU_TAKEN');
  const message = (key: string | undefined, fallback: MessageKey): string =>
    key === 'SKU_TAKEN' || key === 'nameRequired' ? t(`inventory.sku.errors.${key}`) : t(fallback);

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('inventory.cancel')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-lg"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => void form.handleSubmit((values) => mutation.mutate(values))(event)}
        >
          <DialogHeader>
            <DialogTitle>{t('inventory.sku.createTitle')}</DialogTitle>
            <DialogDescription>{t('inventory.sku.createDescription')}</DialogDescription>
          </DialogHeader>

          {failed && (
            <Alert variant="destructive">
              <AlertDescription>{t('inventory.sku.errors.generic')}</AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <Field data-invalid={!!errors.code}>
              <FieldLabel htmlFor="sku-code">
                {t('inventory.sku.code')}
                <span className="font-normal text-muted-foreground">
                  ({t('inventory.required')})
                </span>
              </FieldLabel>
              <Input
                id="sku-code"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                aria-required
                aria-invalid={!!errors.code}
                aria-describedby={errors.code ? 'sku-code-error' : 'sku-code-hint'}
                {...form.register('code')}
              />
              {errors.code ? (
                <FieldError id="sku-code-error">
                  {message(errors.code.message, 'inventory.sku.errors.codeInvalid')}
                </FieldError>
              ) : (
                <FieldDescription id="sku-code-hint">
                  {t('inventory.sku.codeHint')}
                </FieldDescription>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor="sku-name-en">{t('inventory.sku.nameEn')}</FieldLabel>
                <Input
                  id="sku-name-en"
                  lang="en"
                  dir="ltr"
                  autoComplete="off"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={errors.nameEn ? 'sku-name-error' : 'sku-name-hint'}
                  {...form.register('nameEn')}
                />
              </Field>
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor="sku-name-ar">{t('inventory.sku.nameAr')}</FieldLabel>
                <Input
                  id="sku-name-ar"
                  lang="ar"
                  dir="rtl"
                  autoComplete="off"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={errors.nameEn ? 'sku-name-error' : 'sku-name-hint'}
                  {...form.register('nameAr')}
                />
              </Field>
            </div>
            {errors.nameEn ? (
              <FieldError id="sku-name-error" className="-mt-2">
                {message(errors.nameEn.message, 'inventory.sku.errors.nameRequired')}
              </FieldError>
            ) : (
              <FieldDescription id="sku-name-hint" className="-mt-2">
                {t('inventory.sku.nameHint')}
              </FieldDescription>
            )}

            <Field data-invalid={!!errors.price}>
              <FieldLabel htmlFor="sku-price">
                {t('inventory.sku.price')}
                <span className="font-normal text-muted-foreground">
                  ({t('inventory.optional')})
                </span>
              </FieldLabel>
              <Input
                id="sku-price"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                className="tabular-nums sm:max-w-48"
                aria-invalid={!!errors.price}
                aria-describedby={errors.price ? 'sku-price-error' : 'sku-price-hint'}
                {...form.register('price')}
              />
              {errors.price ? (
                <FieldError id="sku-price-error">
                  {t('inventory.sku.errors.priceInvalid')}
                </FieldError>
              ) : (
                <FieldDescription id="sku-price-hint">
                  {t('inventory.sku.priceHint')}
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t('inventory.cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('inventory.sku.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
