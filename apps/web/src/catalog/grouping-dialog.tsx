'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { GroupingCode } from '@ssdashboard/contracts';
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
import { useMutation } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { useReturnFocus } from '@/shared/use-return-focus';
import { createGrouping, updateGrouping, type GroupingKind, type GroupingRow } from './catalog-api';
import { catalogErrorCode } from './catalog-error';
import {
  GROUPING_ERRORS,
  groupingErrorKey,
  groupingPrefix,
  type GroupingErrorCode,
} from './grouping-errors';

/** The form, built from the contract's code schema (spec 0012, AC-6, AC-7). */
const GroupingForm = z
  .object({
    code: GroupingCode,
    nameEn: z.string().trim().max(200),
    nameAr: z.string().trim().max(200),
    startsOn: z.string(),
    endsOn: z.string(),
  })
  .refine((form) => form.nameEn !== '' || form.nameAr !== '', {
    path: ['nameEn'],
    message: 'nameRequired',
  })
  .refine((form) => !form.startsOn || !form.endsOn || form.startsOn <= form.endsOn, {
    path: ['endsOn'],
    message: 'datesOrder',
  });
type FormInput = z.input<typeof GroupingForm>;
type FormOutput = z.output<typeof GroupingForm>;

const valuesOf = (row: GroupingRow | undefined): FormInput => ({
  code: row?.code ?? '',
  nameEn: row?.name.en ?? '',
  nameAr: row?.name.ar ?? '',
  startsOn: row && 'startsOn' in row ? (row.startsOn ?? '') : '',
  endsOn: row && 'endsOn' in row ? (row.endsOn ?? '') : '',
});

/** Props of `GroupingDialog`. */
interface Props {
  kind: GroupingKind;
  /** The row to edit; absent to create one. */
  row?: GroupingRow;
  /** Reads the list again and hands back this row as stored now (gone: undefined). */
  onReload?: () => Promise<GroupingRow | undefined>;
  /** After a save, so the page refreshes its lists. */
  onSaved: () => void;
  onClose: () => void;
}

/**
 * Creates or edits one season or product group (spec 0012, AC-6, AC-7): code, name in English
 * and Arabic, and for seasons optional start and end dates in order. An edit sends `updatedAt`
 * exactly as read and only the fields that changed; a stale answer offers a reload. A protected
 * row (`CORE`, `MAIN`) keeps its code, so the code is read only and never sent.
 */
export function GroupingDialog({ kind, row, onReload, onSaved, onClose }: Props) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const prefix = groupingPrefix(kind);
  const [current, setCurrent] = useState(row);
  const [failure, setFailure] = useState<GroupingErrorCode | null>(null);
  const [reloading, setReloading] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(GroupingForm),
    mode: 'onTouched',
    defaultValues: valuesOf(row),
  });
  const { errors } = form.formState;
  const codeLocked = current?.protected === true;
  const seasons = kind === 'season';

  const mutation = useMutation({
    mutationFn: (values: FormOutput) => {
      const name = { en: values.nameEn, ar: values.nameAr };
      if (!current) {
        return createGrouping(kind, {
          code: values.code,
          name,
          ...(values.startsOn && { startsOn: values.startsOn }),
          ...(values.endsOn && { endsOn: values.endsOn }),
        });
      }
      const before = valuesOf(current);
      return updateGrouping(kind, current.id, {
        updatedAt: current.updatedAt,
        ...(!codeLocked && values.code !== current.code && { code: values.code }),
        ...((values.nameEn !== before.nameEn || values.nameAr !== before.nameAr) && { name }),
        ...(seasons &&
          values.startsOn !== before.startsOn && { startsOn: values.startsOn || null }),
        ...(seasons && values.endsOn !== before.endsOn && { endsOn: values.endsOn || null }),
      });
    },
    onSuccess: (saved) => {
      onSaved();
      toast.success(t(`catalog.${prefix}.${current ? 'saved' : 'created'}`, { code: saved.code }));
      onClose();
    },
    onError: (error) => {
      const code = catalogErrorCode(error, GROUPING_ERRORS);
      if (code === 'SEASON_CODE_TAKEN' || code === 'PRODUCT_GROUP_CODE_TAKEN') {
        form.setError('code', { message: 'taken' }, { shouldFocus: true });
        return;
      }
      setFailure(code);
    },
  });

  const reload = async () => {
    if (!onReload) return;
    setReloading(true);
    try {
      const latest = await onReload();
      if (latest) {
        setCurrent(latest);
        form.reset(valuesOf(latest));
        mutation.reset();
        setFailure(null);
      } else {
        // Gone for good: say so, never close without a word.
        setFailure('NOT_FOUND');
      }
    } finally {
      setReloading(false);
    }
  };

  const pending = mutation.isPending;
  const id = (field: string) => `${prefix}-dialog-${field}`;

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('catalog.common.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-lg"
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
            <DialogTitle>
              {current
                ? t(`catalog.${prefix}.editTitle`, { code: current.code })
                : t(`catalog.${prefix}.createTitle`)}
            </DialogTitle>
            <DialogDescription>
              {current
                ? t(`catalog.${prefix}.editDescription`)
                : t(`catalog.${prefix}.createDescription`)}
            </DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {t(groupingErrorKey(kind, failure))}
                {failure === 'STALE_RECORD' && onReload && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={reloading}
                    onClick={() => void reload()}
                  >
                    {t('catalog.common.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <Field data-invalid={!!errors.code}>
              <FieldLabel htmlFor={id('code')}>{t('catalog.grouping.code')}</FieldLabel>
              <Input
                id={id('code')}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                className="sm:max-w-48"
                readOnly={codeLocked}
                aria-invalid={!!errors.code}
                aria-describedby={id(errors.code ? 'code-error' : 'code-hint')}
                {...form.register('code')}
              />
              {errors.code ? (
                <FieldError id={id('code-error')}>
                  {errors.code.message === 'taken'
                    ? t(groupingErrorKey(kind, 'SEASON_CODE_TAKEN'))
                    : t('catalog.grouping.codeInvalid')}
                </FieldError>
              ) : (
                <FieldDescription id={id('code-hint')}>
                  {codeLocked
                    ? t(`catalog.${prefix}.codeProtectedHint`)
                    : t('catalog.grouping.codeHint')}
                </FieldDescription>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor={id('name-en')}>{t('catalog.grouping.nameEn')}</FieldLabel>
                <Input
                  id={id('name-en')}
                  lang="en"
                  dir="ltr"
                  autoComplete="off"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={id(errors.nameEn ? 'name-error' : 'name-hint')}
                  {...form.register('nameEn')}
                />
              </Field>
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor={id('name-ar')}>{t('catalog.grouping.nameAr')}</FieldLabel>
                <Input
                  id={id('name-ar')}
                  lang="ar"
                  dir="rtl"
                  autoComplete="off"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={id(errors.nameEn ? 'name-error' : 'name-hint')}
                  {...form.register('nameAr')}
                />
              </Field>
            </div>
            {errors.nameEn ? (
              <FieldError id={id('name-error')} className="-mt-2">
                {t('catalog.grouping.nameRequired')}
              </FieldError>
            ) : (
              <FieldDescription id={id('name-hint')} className="-mt-2">
                {t('catalog.grouping.nameHint')}
              </FieldDescription>
            )}

            {seasons && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={id('starts-on')}>
                      {t('catalog.grouping.startsOn')}
                      <span className="font-normal text-muted-foreground">
                        ({t('catalog.common.optional')})
                      </span>
                    </FieldLabel>
                    <Input
                      id={id('starts-on')}
                      type="date"
                      dir="ltr"
                      aria-describedby={id('dates-hint')}
                      {...form.register('startsOn')}
                    />
                  </Field>
                  <Field data-invalid={!!errors.endsOn}>
                    <FieldLabel htmlFor={id('ends-on')}>
                      {t('catalog.grouping.endsOn')}
                      <span className="font-normal text-muted-foreground">
                        ({t('catalog.common.optional')})
                      </span>
                    </FieldLabel>
                    <Input
                      id={id('ends-on')}
                      type="date"
                      dir="ltr"
                      aria-invalid={!!errors.endsOn}
                      aria-describedby={id(errors.endsOn ? 'dates-error' : 'dates-hint')}
                      {...form.register('endsOn')}
                    />
                  </Field>
                </div>
                {errors.endsOn ? (
                  <FieldError id={id('dates-error')} className="-mt-2">
                    {t('catalog.grouping.datesOrder')}
                  </FieldError>
                ) : (
                  <FieldDescription id={id('dates-hint')} className="-mt-2">
                    {t('catalog.grouping.datesHint')}
                  </FieldDescription>
                )}
              </>
            )}
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
              {current ? t('catalog.grouping.save') : t('catalog.grouping.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
