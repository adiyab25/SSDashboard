'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { LocationCode, WorkLocationKind, type LocationDetail } from '@ssdashboard/contracts';
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
import { Label } from '@ssdashboard/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@ssdashboard/ui/components/radio-group';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { useLocationSwitcher } from '@/shell/current-location-provider';
import { inventoryKeys, updateLocation } from './inventory-api';
import { useReturnFocus } from '@/shared/use-return-focus';

/** The form, built from the contract's field schemas (spec 0006, AC-4). */
const EditLocationForm = z
  .object({
    code: LocationCode,
    nameEn: z.string().trim().max(200),
    nameAr: z.string().trim().max(200),
    kind: WorkLocationKind,
  })
  .refine((form) => form.nameEn !== '' || form.nameAr !== '', {
    path: ['nameEn'],
    message: 'nameRequired',
  });
type EditInput = z.input<typeof EditLocationForm>;
type EditOutput = z.output<typeof EditLocationForm>;

const KINDS = ['warehouse', 'shop'] as const;

const KNOWN = [
  'STALE_RECORD',
  'CODE_LOCKED',
  'LOCATION_CODE_TAKEN',
  'BUSY',
  'ONLINE_NEEDS_WAREHOUSE',
] as const;
type KnownCode = (typeof KNOWN)[number];

const valuesOf = (location: LocationDetail): EditInput => ({
  code: location.code,
  nameEn: location.name.en ?? '',
  nameAr: location.name.ar ?? '',
  kind: location.kind,
});

interface Props {
  location: LocationDetail;
  /** Refetches the list and hands back this location as stored now (gone: undefined). */
  onReload: () => Promise<LocationDetail | undefined>;
  onClose: () => void;
}

/**
 * Edits a location (spec 0006, AC-4). Admins only; the api enforces it too. `updatedAt` goes
 * back exactly as read, the code is read only once `codeLocked`, and a stale answer offers a
 * reload.
 */
export function LocationEditDialog({ location, onReload, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const returnFocus = useReturnFocus();
  const { retry: reloadSwitcher } = useLocationSwitcher();
  const [current, setCurrent] = useState(location);
  const [failure, setFailure] = useState<
    Exclude<KnownCode, 'LOCATION_CODE_TAKEN'> | 'generic' | null
  >(null);
  const [reloading, setReloading] = useState(false);
  const form = useForm<EditInput, unknown, EditOutput>({
    resolver: zodResolver(EditLocationForm),
    mode: 'onTouched',
    defaultValues: valuesOf(location),
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (values: EditOutput) =>
      updateLocation(current.id, {
        updatedAt: current.updatedAt,
        ...(!current.codeLocked && values.code !== current.code && { code: values.code }),
        ...((values.nameEn !== (current.name.en ?? '') ||
          values.nameAr !== (current.name.ar ?? '')) && {
          name: { en: values.nameEn, ar: values.nameAr },
        }),
        ...(values.kind !== current.kind && { kind: values.kind }),
      }),
    onSuccess: (next) => {
      reloadSwitcher();
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.locations });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.stockAll });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.receiptsRoot });
      toast.success(t('inventory.locations.saved', { code: next.code }));
      onClose();
    },
    onError: (error) => {
      const code =
        error instanceof ApiError && (KNOWN as readonly string[]).includes(error.code)
          ? (error.code as KnownCode)
          : 'generic';
      if (code === 'LOCATION_CODE_TAKEN') {
        form.setError('code', { message: code }, { shouldFocus: true });
        return;
      }
      setFailure(code);
    },
  });

  const reload = async () => {
    setReloading(true);
    try {
      const latest = await onReload();
      if (latest) {
        setCurrent(latest);
        form.reset(valuesOf(latest));
        mutation.reset();
        setFailure(null);
      } else {
        onClose();
      }
    } finally {
      setReloading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('inventory.locations.close')}
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
            <DialogTitle>{t('inventory.locations.editTitle', { code: current.code })}</DialogTitle>
            <DialogDescription>{t('inventory.locations.editDescription')}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {t(`inventory.locations.errors.${failure}`)}
                {failure === 'STALE_RECORD' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={reloading}
                    onClick={() => void reload()}
                  >
                    {t('inventory.locations.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <Field data-invalid={!!errors.code}>
              <FieldLabel htmlFor="location-edit-code">{t('inventory.location.code')}</FieldLabel>
              <Input
                id="location-edit-code"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                className="sm:max-w-48"
                readOnly={current.codeLocked}
                aria-invalid={!!errors.code}
                aria-describedby={
                  errors.code
                    ? 'location-edit-code-error'
                    : current.codeLocked
                      ? 'location-edit-code-locked'
                      : 'location-edit-code-hint'
                }
                {...form.register('code')}
              />
              {errors.code ? (
                <FieldError id="location-edit-code-error">
                  {errors.code.message === 'LOCATION_CODE_TAKEN'
                    ? t('inventory.locations.errors.LOCATION_CODE_TAKEN')
                    : t('inventory.location.errors.codeInvalid')}
                </FieldError>
              ) : current.codeLocked ? (
                <FieldDescription id="location-edit-code-locked">
                  {t('inventory.locations.codeLockedHint')}
                </FieldDescription>
              ) : (
                <FieldDescription id="location-edit-code-hint">
                  {t('inventory.location.codeHint')}
                </FieldDescription>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor="location-edit-name-en">
                  {t('inventory.location.nameEn')}
                </FieldLabel>
                <Input
                  id="location-edit-name-en"
                  lang="en"
                  dir="ltr"
                  autoComplete="off"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={errors.nameEn ? 'location-edit-name-error' : undefined}
                  {...form.register('nameEn')}
                />
              </Field>
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor="location-edit-name-ar">
                  {t('inventory.location.nameAr')}
                </FieldLabel>
                <Input
                  id="location-edit-name-ar"
                  lang="ar"
                  dir="rtl"
                  autoComplete="off"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={errors.nameEn ? 'location-edit-name-error' : undefined}
                  {...form.register('nameAr')}
                />
              </Field>
            </div>
            {errors.nameEn && (
              <FieldError id="location-edit-name-error" className="-mt-2">
                {t('inventory.location.errors.nameRequired')}
              </FieldError>
            )}

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">{t('inventory.location.type')}</legend>
              <Controller
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <RadioGroup
                    value={field.value}
                    onValueChange={field.onChange}
                    className="flex flex-wrap gap-4"
                  >
                    {KINDS.map((kind) => (
                      <div key={kind} className="flex items-center gap-2">
                        <RadioGroupItem value={kind} id={`location-edit-kind-${kind}`} />
                        <Label htmlFor={`location-edit-kind-${kind}`} className="font-normal">
                          {t(`inventory.location.${kind}`)}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}
              />
            </fieldset>
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
              {t('inventory.locations.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
