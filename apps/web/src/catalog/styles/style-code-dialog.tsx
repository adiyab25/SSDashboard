'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { SkuCode, type StyleDetail } from '@ssdashboard/contracts';
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
import { toast } from 'sonner';
import { z } from 'zod';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { inventoryKeys } from '@/inventory/inventory-api';
import { useReturnFocus } from '@/shared/use-return-focus';
import { catalogKeys, changeStyleCode } from '../catalog-api';
import { catalogErrorCode } from '../catalog-error';

/** The form: one style code, in the SKU code shape the contract checks (AC-9). */
const StyleCodeForm = z.object({ code: SkuCode });
type FormInput = z.input<typeof StyleCodeForm>;
type FormOutput = z.output<typeof StyleCodeForm>;

const KNOWN = ['STYLE_CODE_TAKEN', 'STALE_RECORD', 'INVALID_INPUT', 'NOT_FOUND'] as const;
type Failure = Exclude<(typeof KNOWN)[number], 'STYLE_CODE_TAKEN'> | 'generic';

/** Props of `StyleCodeDialog`. */
interface Props {
  style: StyleDetail;
  /** Reads the style again; undefined when that failed. */
  reload: () => Promise<StyleDetail | undefined>;
  onClose: () => void;
}

/**
 * Changes a style code (spec 0012, AC-9; `catalog.manage` only, the page hides it otherwise and
 * the api enforces it). It sends `updatedAt` exactly as read; a code another style holds shows on
 * the field, and a stale answer offers a reload. A change refreshes the style, the style list, and
 * the SKU list (rows show the style code).
 */
export function StyleCodeDialog({ style, reload, onClose }: Props) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(style);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reloading, setReloading] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(StyleCodeForm),
    mode: 'onTouched',
    defaultValues: { code: style.code },
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (values: FormOutput) =>
      changeStyleCode(current.id, { updatedAt: current.updatedAt, code: values.code }),
    onSuccess: (next) => {
      queryClient.setQueryData(catalogKeys.style(next.id), next);
      void refetchAfterWrite(queryClient, { queryKey: catalogKeys.styles });
      void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.skus });
      toast.success(t('catalog.styleCode.saved', { code: next.code }));
      onClose();
    },
    onError: (error) => {
      const code = catalogErrorCode(error, KNOWN);
      if (code === 'STYLE_CODE_TAKEN') {
        form.setError('code', { message: 'taken' }, { shouldFocus: true });
        return;
      }
      setFailure(code);
    },
  });

  const reloadLatest = async () => {
    setReloading(true);
    try {
      const latest = await reload();
      if (latest) {
        setCurrent(latest);
        form.reset({ code: latest.code });
        mutation.reset();
        setFailure(null);
      }
    } finally {
      setReloading(false);
    }
  };

  const pending = mutation.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('catalog.common.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-md"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => {
            setFailure(null);
            void form.handleSubmit((values) => {
              if (values.code === current.code) onClose();
              else mutation.mutate(values);
            })(event);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('catalog.styleCode.title', { code: current.code })}</DialogTitle>
            <DialogDescription>{t('catalog.styleCode.description')}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {t(`catalog.styleCode.errors.${failure}`)}
                {failure === 'STALE_RECORD' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={reloading}
                    onClick={() => void reloadLatest()}
                  >
                    {t('catalog.common.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          <Field data-invalid={!!errors.code}>
            <FieldLabel htmlFor="style-code">{t('catalog.styleCode.code')}</FieldLabel>
            <Input
              id="style-code"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              aria-invalid={!!errors.code}
              aria-describedby={errors.code ? 'style-code-error' : 'style-code-hint'}
              {...form.register('code')}
            />
            {errors.code ? (
              <FieldError id="style-code-error">
                {errors.code.message === 'taken'
                  ? t('catalog.styleCode.errors.STYLE_CODE_TAKEN')
                  : t('catalog.styleCode.codeInvalid')}
              </FieldError>
            ) : (
              <FieldDescription id="style-code-hint">
                {t('catalog.styleCode.codeHint')}
              </FieldDescription>
            )}
          </Field>

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
              {t('catalog.styleCode.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
