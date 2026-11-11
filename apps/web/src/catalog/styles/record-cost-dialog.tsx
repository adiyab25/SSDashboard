'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CostBasis,
  moneyInput,
  UnitCostString,
  type RecordCostRequest,
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
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { useReturnFocus } from '@/shared/use-return-focus';
import { catalogKeys, listGroupingChoices, recordCost } from '../catalog-api';
import { catalogErrorCode } from '../catalog-error';

/** The form, built from the contract's basis and unit cost schemas (spec 0012, AC-13). */
const RecordCostForm = z.object({
  /** An empty id means the style itself. */
  variantId: z.string(),
  seasonId: z.uuid(),
  costBasis: CostBasis,
  unitCost: moneyInput(4).pipe(UnitCostString),
  effectiveFrom: z.iso.date(),
  source: z.string().trim().max(200),
  reason: z.string().trim().max(500),
});
type FormInput = z.input<typeof RecordCostForm>;
type FormOutput = z.output<typeof RecordCostForm>;

const SELECT =
  'h-control w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-ring md:text-sm dark:bg-input/30';

const KNOWN = ['REASON_REQUIRED', 'INVALID_INPUT', 'NOT_FOUND', 'FORBIDDEN'] as const;
type Failure = Exclude<(typeof KNOWN)[number], 'REASON_REQUIRED'> | 'generic';

/**
 * Records a cost for a style or one of its SKUs (spec 0012, AC-13, `catalog.edit` plus
 * `cost.view`): who it applies to, the season (an archived one is offered and labelled), the
 * basis, the unit cost (Arabic or Western digits, at most 4 decimals), the day it applies from,
 * an optional source, and a reason. The reason is only demanded by the api, when the day is
 * before today (422 `REASON_REQUIRED`): then its field shows the error and the dialog stays
 * open. A record is never edited; a correction is a new record. Open it only for a person who
 * holds both permissions.
 */
export function RecordCostDialog({ style, onClose }: { style: StyleDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const format = useFormat();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<Failure | null>(null);
  const seasons = useQuery({
    queryKey: catalogKeys.allSeasons,
    queryFn: ({ signal }) => listGroupingChoices('season', signal, 'all'),
  });
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(RecordCostForm),
    mode: 'onTouched',
    defaultValues: {
      variantId: '',
      seasonId: style.season?.id ?? '',
      costBasis: 'factory_invoice',
      unitCost: '',
      effectiveFrom: '',
      source: '',
      reason: '',
    },
  });
  const { errors } = form.formState;
  // The install's operating day is known only once its time zone has loaded: fill the day then,
  // and never over a day the person already picked.
  const today = format.calendarDate(new Date());
  useEffect(() => {
    if (today && !form.getFieldState('effectiveFrom').isDirty && !form.getValues('effectiveFrom')) {
      form.setValue('effectiveFrom', today);
    }
  }, [today, form]);

  const mutation = useMutation({
    mutationFn: (values: FormOutput) => {
      const body: RecordCostRequest = {
        seasonId: values.seasonId,
        costBasis: values.costBasis,
        unitCost: values.unitCost,
        effectiveFrom: values.effectiveFrom,
        ...(values.variantId !== '' && { variantId: values.variantId }),
        ...(values.source !== '' && { source: values.source }),
        ...(values.reason !== '' && { reason: values.reason }),
      };
      return recordCost(style.id, body);
    },
    onSuccess: () => {
      void refetchAfterWrite(queryClient, { queryKey: catalogKeys.style(style.id) });
      void refetchAfterWrite(queryClient, { queryKey: catalogKeys.costRecords(style.id) });
      toast.success(t('catalog.cost.record.saved', { code: style.code }));
      onClose();
    },
    onError: (error) => {
      const code = catalogErrorCode(error, KNOWN);
      if (code === 'REASON_REQUIRED') {
        form.setError('reason', { message: 'required' }, { shouldFocus: true });
        return;
      }
      setFailure(code);
    },
  });

  const pending = mutation.isPending;
  const seasonsReady = seasons.isSuccess;

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
            <DialogTitle>{t('catalog.cost.record.title', { code: style.code })}</DialogTitle>
            <DialogDescription>{t('catalog.cost.record.description')}</DialogDescription>
          </DialogHeader>

          {(failure || seasons.isError) && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {failure
                  ? t(`catalog.cost.record.errors.${failure}`)
                  : t('catalog.cost.record.seasonsError')}
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="record-cost-variant">
                  {t('catalog.cost.record.variant')}
                </FieldLabel>
                <select id="record-cost-variant" className={SELECT} {...form.register('variantId')}>
                  <option value="">{t('catalog.cost.record.wholeStyle')}</option>
                  {style.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.code}
                    </option>
                  ))}
                </select>
              </Field>
              <Field data-invalid={!!errors.seasonId}>
                <FieldLabel htmlFor="record-cost-season">
                  {t('catalog.cost.record.season')}
                </FieldLabel>
                <select
                  key={seasonsReady ? 'ready' : 'loading'}
                  id="record-cost-season"
                  className={SELECT}
                  disabled={!seasonsReady}
                  aria-invalid={!!errors.seasonId}
                  aria-describedby={errors.seasonId ? 'record-cost-season-error' : undefined}
                  {...form.register('seasonId')}
                >
                  <option value="">
                    {seasons.isPending
                      ? t('catalog.cost.record.seasonsLoading')
                      : t('catalog.cost.record.seasonPlaceholder')}
                  </option>
                  {(seasons.data ?? []).map((season) => (
                    <option key={season.id} value={season.id}>
                      {season.archived
                        ? t('catalog.common.archivedChoice', {
                            name: text(season.name, season.code),
                          })
                        : text(season.name, season.code)}
                    </option>
                  ))}
                </select>
                {errors.seasonId && (
                  <FieldError id="record-cost-season-error">
                    {t('catalog.cost.record.seasonPlaceholder')}
                  </FieldError>
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="record-cost-basis">
                  {t('catalog.cost.record.basis')}
                </FieldLabel>
                <select id="record-cost-basis" className={SELECT} {...form.register('costBasis')}>
                  {CostBasis.options.map((basis) => (
                    <option key={basis} value={basis}>
                      {t(`catalog.cost.basis.${basis}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field data-invalid={!!errors.unitCost}>
                <FieldLabel htmlFor="record-cost-unit-cost">
                  {t('catalog.cost.record.unitCost')}
                </FieldLabel>
                <Input
                  id="record-cost-unit-cost"
                  dir="ltr"
                  inputMode="decimal"
                  autoComplete="off"
                  className="tabular-nums"
                  aria-invalid={!!errors.unitCost}
                  aria-describedby={
                    errors.unitCost ? 'record-cost-unit-cost-error' : 'record-cost-unit-cost-hint'
                  }
                  {...form.register('unitCost')}
                />
                {errors.unitCost ? (
                  <FieldError id="record-cost-unit-cost-error">
                    {t('catalog.cost.record.unitCostInvalid')}
                  </FieldError>
                ) : (
                  <FieldDescription id="record-cost-unit-cost-hint">
                    {t('catalog.cost.record.unitCostHint')}
                  </FieldDescription>
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.effectiveFrom}>
                <FieldLabel htmlFor="record-cost-effective-from">
                  {t('catalog.cost.record.effectiveFrom')}
                </FieldLabel>
                <Input
                  id="record-cost-effective-from"
                  type="date"
                  dir="ltr"
                  aria-invalid={!!errors.effectiveFrom}
                  aria-describedby={
                    errors.effectiveFrom ? 'record-cost-effective-from-error' : undefined
                  }
                  {...form.register('effectiveFrom')}
                />
                {errors.effectiveFrom && (
                  <FieldError id="record-cost-effective-from-error">
                    {t('catalog.cost.record.effectiveFromInvalid')}
                  </FieldError>
                )}
              </Field>
              <Field data-invalid={!!errors.source}>
                <FieldLabel htmlFor="record-cost-source">
                  {t('catalog.cost.record.source')}
                  <span className="font-normal text-muted-foreground">
                    ({t('catalog.common.optional')})
                  </span>
                </FieldLabel>
                <Input
                  id="record-cost-source"
                  autoComplete="off"
                  aria-invalid={!!errors.source}
                  aria-describedby={
                    errors.source ? 'record-cost-source-error' : 'record-cost-source-hint'
                  }
                  {...form.register('source')}
                />
                {errors.source ? (
                  <FieldError id="record-cost-source-error">
                    {t('catalog.cost.record.sourceInvalid')}
                  </FieldError>
                ) : (
                  <FieldDescription id="record-cost-source-hint">
                    {t('catalog.cost.record.sourceHint')}
                  </FieldDescription>
                )}
              </Field>
            </div>

            <Field data-invalid={!!errors.reason}>
              <FieldLabel htmlFor="record-cost-reason">
                {t('catalog.cost.record.reason')}
              </FieldLabel>
              <Textarea
                id="record-cost-reason"
                rows={2}
                aria-invalid={!!errors.reason}
                aria-describedby={
                  errors.reason ? 'record-cost-reason-error' : 'record-cost-reason-hint'
                }
                {...form.register('reason')}
              />
              {errors.reason ? (
                <FieldError id="record-cost-reason-error">
                  {errors.reason.message === 'required'
                    ? t('catalog.cost.record.reasonRequired')
                    : t('catalog.cost.record.reasonInvalid')}
                </FieldError>
              ) : (
                <FieldDescription id="record-cost-reason-hint">
                  {t('catalog.cost.record.reasonHint')} {t('catalog.cost.record.reasonNoAmounts')}
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('catalog.common.cancel')}
            </Button>
            {seasonsReady ? (
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending && (
                  <LoaderCircleIcon
                    aria-hidden
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                  />
                )}
                {t('catalog.cost.record.save')}
              </Button>
            ) : (
              !seasons.isError && (
                <span role="status" className="text-sm text-muted-foreground">
                  {t('catalog.cost.record.seasonsLoading')}
                </span>
              )
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
