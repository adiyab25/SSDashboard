'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { LocationCode, WorkLocationType } from '@ssdashboard/contracts';
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
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { useLocationSwitcher } from '@/shell/current-location';
import { createLocation, inventoryKeys } from './inventory-api';

/** The form, built from the contract's field schemas (spec 0006, AC-4). */
const NewLocationForm = z
  .object({
    code: LocationCode,
    nameEn: z.string().trim().max(200),
    nameAr: z.string().trim().max(200),
    type: WorkLocationType,
  })
  .refine((form) => form.nameEn !== '' || form.nameAr !== '', {
    path: ['nameEn'],
    message: 'nameRequired',
  });
type NewLocationInput = z.input<typeof NewLocationForm>;
type NewLocationOutput = z.output<typeof NewLocationForm>;

const TYPES = ['warehouse', 'showroom'] as const;

/** Creates a warehouse or showroom. Admins only; the api enforces it too. */
export function NewLocationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { retry: reloadLocations } = useLocationSwitcher();
  const form = useForm<NewLocationInput, unknown, NewLocationOutput>({
    resolver: zodResolver(NewLocationForm),
    mode: 'onTouched',
    defaultValues: { code: '', nameEn: '', nameAr: '', type: 'warehouse' },
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (values: NewLocationOutput) =>
      createLocation({
        code: values.code,
        name: { en: values.nameEn, ar: values.nameAr },
        type: values.type,
      }),
    onSuccess: (location) => {
      // The shell's switcher and every stock list name locations.
      reloadLocations();
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.stockAll });
      toast.success(t('inventory.location.created', { code: location.code }));
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'LOCATION_CODE_TAKEN') {
        form.setError('code', { message: 'LOCATION_CODE_TAKEN' }, { shouldFocus: true });
      }
    },
  });

  const failed =
    mutation.error &&
    !(mutation.error instanceof ApiError && mutation.error.code === 'LOCATION_CODE_TAKEN');

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent closeLabel={t('inventory.cancel')} className="sm:max-w-lg">
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => void form.handleSubmit((values) => mutation.mutate(values))(event)}
        >
          <DialogHeader>
            <DialogTitle>{t('inventory.location.createTitle')}</DialogTitle>
            <DialogDescription>{t('inventory.location.createDescription')}</DialogDescription>
          </DialogHeader>

          {failed && (
            <Alert variant="destructive">
              <AlertDescription>{t('inventory.location.errors.generic')}</AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <Field data-invalid={!!errors.code}>
              <FieldLabel htmlFor="location-code">
                {t('inventory.location.code')}
                <span className="font-normal text-muted-foreground">
                  ({t('inventory.required')})
                </span>
              </FieldLabel>
              <Input
                id="location-code"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                className="sm:max-w-48"
                aria-required
                aria-invalid={!!errors.code}
                aria-describedby={errors.code ? 'location-code-error' : 'location-code-hint'}
                {...form.register('code')}
              />
              {errors.code ? (
                <FieldError id="location-code-error">
                  {errors.code.message === 'LOCATION_CODE_TAKEN'
                    ? t('inventory.location.errors.LOCATION_CODE_TAKEN')
                    : t('inventory.location.errors.codeInvalid')}
                </FieldError>
              ) : (
                <FieldDescription id="location-code-hint">
                  {t('inventory.location.codeHint')}
                </FieldDescription>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor="location-name-en">{t('inventory.location.nameEn')}</FieldLabel>
                <Input
                  id="location-name-en"
                  lang="en"
                  dir="ltr"
                  autoComplete="off"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={errors.nameEn ? 'location-name-error' : undefined}
                  {...form.register('nameEn')}
                />
              </Field>
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor="location-name-ar">{t('inventory.location.nameAr')}</FieldLabel>
                <Input
                  id="location-name-ar"
                  lang="ar"
                  dir="rtl"
                  autoComplete="off"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={errors.nameEn ? 'location-name-error' : undefined}
                  {...form.register('nameAr')}
                />
              </Field>
            </div>
            {errors.nameEn && (
              <FieldError id="location-name-error" className="-mt-2">
                {t('inventory.location.errors.nameRequired')}
              </FieldError>
            )}

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">{t('inventory.location.type')}</legend>
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <RadioGroup
                    value={field.value}
                    onValueChange={field.onChange}
                    className="flex flex-wrap gap-4"
                  >
                    {TYPES.map((type) => (
                      <div key={type} className="flex items-center gap-2">
                        <RadioGroupItem value={type} id={`location-type-${type}`} />
                        <Label htmlFor={`location-type-${type}`} className="font-normal">
                          {t(`inventory.location.${type}`)}
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
              {t('inventory.location.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
