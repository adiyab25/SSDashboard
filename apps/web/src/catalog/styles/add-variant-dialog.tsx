'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  BarcodeCode,
  moneyInput,
  PriceString,
  SkuCode,
  type StyleDetail,
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { inventoryKeys } from '@/inventory/inventory-api';
import { useReturnFocus } from '@/shared/use-return-focus';
import { addVariant, catalogKeys } from '../catalog-api';
import { barcodeHolder, catalogErrorCode, channelOwnedField } from '../catalog-error';
import { FromChannelBadge } from '../from-channel-badge';
import { SELECT_CLASS } from '@/shared/select-class';

/** A style has at most this many options (AC-10). */
const MAX_OPTIONS = 3;

/** One option row: both filled, or both empty (an empty row is dropped). */
const OptionRow = z
  .object({ name: z.string().trim().max(200), value: z.string().trim().max(200) })
  .refine((row) => (row.name === '') === (row.value === ''), {
    path: ['value'],
    message: 'incomplete',
  });

/** The form, built from the contract's code, price, and barcode schemas (spec 0012, AC-10). */
const AddVariantForm = z.object({
  sku: SkuCode,
  options: z.array(OptionRow).max(MAX_OPTIONS),
  price: z.union([z.literal(''), moneyInput(2).pipe(PriceString)]),
  barcode: z.union([z.literal(''), BarcodeCode]),
});
type FormInput = z.input<typeof AddVariantForm>;
type FormOutput = z.output<typeof AddVariantForm>;

/** Arabic letters: a name or value typed in Arabic is stored as its Arabic text. */
const ARABIC = /[؀-ۿ]/;
const textOf = (value: string) => (ARABIC.test(value) ? { ar: value } : { en: value });

const KNOWN = [
  'SKU_TAKEN',
  'BARCODE_TAKEN',
  'OPTION_COMBINATION_TAKEN',
  'TOO_MANY_OPTIONS',
  'ARCHIVED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'FIELD_OWNED_BY_CHANNEL',
] as const;
type Failure = Exclude<(typeof KNOWN)[number], 'SKU_TAKEN' | 'BARCODE_TAKEN'> | 'generic';

/** Props of `AddVariantDialog`. */
interface Props {
  style: StyleDetail;
  onClose: () => void;
}

/**
 * Adds a SKU to a style (spec 0012, AC-10, `catalog.edit`): a SKU code, up to 3 option name and
 * value pairs, an optional price, and an optional barcode. The rows start with the style's own
 * option names, and the names and values it already has are offered as suggestions; the api
 * matches them in either language after normalizing, and a new name adds an option. Each text is
 * sent in the language its script shows (Arabic letters as Arabic, anything else as English). A
 * code or a barcode another SKU holds shows on its field, naming the SKU that holds the barcode.
 * On a style linked to a sales channel the options are Shopify's (AC-15): the rows show the
 * style's option names read only and offer only its existing values, with no way to add an
 * option or a new value (the api answers `FIELD_OWNED_BY_CHANNEL` otherwise).
 */
export function AddVariantDialog({ style, onClose }: Props) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [holder, setHolder] = useState<string | undefined>();
  const [ownedField, setOwnedField] = useState(channelOwnedField(undefined));
  const linked = style.channelLinked;
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(AddVariantForm),
    mode: 'onTouched',
    defaultValues: {
      sku: '',
      options:
        style.options.length === 0
          ? linked
            ? []
            : [{ name: '', value: '' }]
          : style.options
              .slice(0, MAX_OPTIONS)
              .map((option) => ({ name: text(option.name, ''), value: '' })),
      price: '',
      barcode: '',
    },
  });
  const rows = useFieldArray({ control: form.control, name: 'options' });
  const { errors } = form.formState;
  const typedNames = useWatch({ control: form.control, name: 'options' });

  const mutation = useMutation({
    mutationFn: (values: FormOutput) =>
      addVariant(style.id, {
        sku: values.sku,
        options: values.options
          .filter((row) => row.name !== '')
          .map((row) => ({ name: textOf(row.name), value: textOf(row.value) })),
        ...(values.price !== '' && { price: values.price }),
        ...(values.barcode !== '' && { barcode: values.barcode }),
      }),
    onSuccess: (sku) => {
      void refetchAfterWrite(queryClient, { queryKey: catalogKeys.styles });
      void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.skus });
      toast.success(t('catalog.addVariant.saved', { code: sku.code }));
      onClose();
    },
    onError: (error) => {
      const code = catalogErrorCode(error, KNOWN);
      if (code === 'SKU_TAKEN') {
        form.setError('sku', { message: 'taken' }, { shouldFocus: true });
        return;
      }
      if (code === 'BARCODE_TAKEN') {
        setHolder(barcodeHolder(error));
        form.setError('barcode', { message: 'taken' }, { shouldFocus: true });
        return;
      }
      setOwnedField(channelOwnedField(error));
      setFailure(code);
    },
  });

  /** The values the style already has for the option named like this row, as suggestions. */
  const valuesFor = (name: string | undefined) => {
    const key = (name ?? '').trim().toLowerCase();
    const option = style.options.find((candidate) =>
      [candidate.name.en, candidate.name.ar].some(
        (label) => label !== undefined && label.trim().toLowerCase() === key,
      ),
    );
    return option ? option.values.map((value) => text(value, '')) : [];
  };

  const takenBarcode = errors.barcode?.message === 'taken';
  const pending = mutation.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('catalog.common.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-xl"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => {
            setFailure(null);
            void form.handleSubmit((values) => mutation.mutate(values))(event);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('catalog.addVariant.title', { code: style.code })}</DialogTitle>
            <DialogDescription>{t('catalog.addVariant.description')}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {failure === 'FIELD_OWNED_BY_CHANNEL'
                  ? t(`catalog.channel.owned.${ownedField}`)
                  : t(`catalog.addVariant.errors.${failure}`)}
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <Field data-invalid={!!errors.sku}>
              <FieldLabel htmlFor="add-variant-sku">{t('catalog.addVariant.sku')}</FieldLabel>
              <Input
                id="add-variant-sku"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                className="sm:max-w-64"
                aria-invalid={!!errors.sku}
                aria-describedby={errors.sku ? 'add-variant-sku-error' : 'add-variant-sku-hint'}
                {...form.register('sku')}
              />
              {errors.sku ? (
                <FieldError id="add-variant-sku-error">
                  {errors.sku.message === 'taken'
                    ? t('catalog.addVariant.errors.SKU_TAKEN')
                    : t('catalog.addVariant.skuInvalid')}
                </FieldError>
              ) : (
                <FieldDescription id="add-variant-sku-hint">
                  {t('catalog.addVariant.skuHint')}
                </FieldDescription>
              )}
            </Field>

            <fieldset className="flex flex-col gap-3" aria-describedby="add-variant-options-hint">
              <legend className="mb-1 text-sm font-medium">
                {t('catalog.addVariant.optionsLegend')}
                {linked && <FromChannelBadge />}
              </legend>
              <p id="add-variant-options-hint" className="text-xs text-muted-foreground">
                {linked
                  ? style.options.length === 0
                    ? t('catalog.channel.noNewOptions')
                    : t('catalog.channel.optionsLocked')
                  : t('catalog.addVariant.optionsHint')}
              </p>
              <datalist id="add-variant-option-names">
                {style.options.map((option) => (
                  <option key={option.id} value={text(option.name, '')} />
                ))}
              </datalist>
              {rows.fields.map((row, index) => {
                const n = index + 1;
                const rowError = errors.options?.[index]?.value;
                const listId = `add-variant-values-${index}`;
                return (
                  <div key={row.id} className="flex flex-col gap-1">
                    <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                      <Field>
                        <FieldLabel htmlFor={`add-variant-option-name-${index}`}>
                          {t('catalog.addVariant.optionName', { n })}
                        </FieldLabel>
                        <Input
                          id={`add-variant-option-name-${index}`}
                          autoComplete="off"
                          list="add-variant-option-names"
                          readOnly={linked}
                          className="read-only:bg-muted"
                          aria-invalid={!!rowError}
                          aria-describedby={
                            rowError ? `add-variant-option-error-${index}` : undefined
                          }
                          {...form.register(`options.${index}.name`)}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`add-variant-option-value-${index}`}>
                          {t('catalog.addVariant.optionValue', { n })}
                        </FieldLabel>
                        {linked ? (
                          <select
                            id={`add-variant-option-value-${index}`}
                            className={SELECT_CLASS}
                            aria-invalid={!!rowError}
                            aria-describedby={
                              rowError ? `add-variant-option-error-${index}` : undefined
                            }
                            {...form.register(`options.${index}.value`)}
                          >
                            <option value="" />
                            {valuesFor(typedNames[index]?.name).map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            id={`add-variant-option-value-${index}`}
                            autoComplete="off"
                            list={listId}
                            aria-invalid={!!rowError}
                            aria-describedby={
                              rowError ? `add-variant-option-error-${index}` : undefined
                            }
                            {...form.register(`options.${index}.value`)}
                          />
                        )}
                        <datalist id={listId}>
                          {valuesFor(typedNames[index]?.name).map((value) => (
                            <option key={value} value={value} />
                          ))}
                        </datalist>
                      </Field>
                      {linked ? (
                        <span aria-hidden />
                      ) : (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          id={`add-variant-remove-option-${index}`}
                          aria-label={t('catalog.addVariant.removeOption', { n })}
                          onClick={() => {
                            rows.remove(index);
                            // The pressed button unmounts: move focus to the next Remove (it
                            // takes this index) or, on the last row, to Add option.
                            window.requestAnimationFrame(() =>
                              (
                                document.getElementById(`add-variant-remove-option-${index}`) ??
                                document.getElementById('add-variant-add-option')
                              )?.focus(),
                            );
                          }}
                        >
                          <XIcon aria-hidden />
                        </Button>
                      )}
                    </div>
                    {rowError && (
                      <FieldError id={`add-variant-option-error-${index}`}>
                        {t('catalog.addVariant.optionIncomplete')}
                      </FieldError>
                    )}
                  </div>
                );
              })}
              {!linked && rows.fields.length < MAX_OPTIONS && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="self-start"
                  id="add-variant-add-option"
                  onClick={() => rows.append({ name: '', value: '' })}
                >
                  <PlusIcon aria-hidden data-icon="inline-start" />
                  {t('catalog.addVariant.addOption')}
                </Button>
              )}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.price}>
                <FieldLabel htmlFor="add-variant-price">
                  {t('catalog.addVariant.price')}
                  <span className="font-normal text-muted-foreground">
                    ({t('catalog.common.optional')})
                  </span>
                </FieldLabel>
                <Input
                  id="add-variant-price"
                  dir="ltr"
                  inputMode="decimal"
                  autoComplete="off"
                  className="tabular-nums"
                  aria-invalid={!!errors.price}
                  aria-describedby={
                    errors.price ? 'add-variant-price-error' : 'add-variant-price-hint'
                  }
                  {...form.register('price')}
                />
                {errors.price ? (
                  <FieldError id="add-variant-price-error">
                    {t('catalog.addVariant.priceInvalid')}
                  </FieldError>
                ) : (
                  <FieldDescription id="add-variant-price-hint">
                    {t('catalog.addVariant.priceHint')}
                  </FieldDescription>
                )}
              </Field>
              <Field data-invalid={!!errors.barcode}>
                <FieldLabel htmlFor="add-variant-barcode">
                  {t('catalog.addVariant.barcode')}
                  <span className="font-normal text-muted-foreground">
                    ({t('catalog.common.optional')})
                  </span>
                </FieldLabel>
                <Input
                  id="add-variant-barcode"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!errors.barcode}
                  aria-describedby={
                    errors.barcode ? 'add-variant-barcode-error' : 'add-variant-barcode-hint'
                  }
                  {...form.register('barcode')}
                />
                {errors.barcode ? (
                  <FieldError id="add-variant-barcode-error">
                    {takenBarcode
                      ? holder
                        ? t('catalog.addVariant.errors.BARCODE_TAKEN', { sku: holder })
                        : t('catalog.addVariant.errors.BARCODE_TAKEN_OTHER')
                      : t('catalog.addVariant.barcodeInvalid')}
                  </FieldError>
                ) : (
                  <FieldDescription id="add-variant-barcode-hint">
                    {t('catalog.addVariant.barcodeHint')}
                  </FieldDescription>
                )}
              </Field>
            </div>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('catalog.common.cancel')}
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('catalog.addVariant.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
