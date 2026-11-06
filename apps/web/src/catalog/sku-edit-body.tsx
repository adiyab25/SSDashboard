'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type SkuDetail } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMe } from '@/auth/use-me';
import { ConfirmActionDialog } from '@/inventory/confirm-action-dialog';
import {
  changeSkuCode,
  deleteSku,
  getSkuUsage,
  inventoryKeys,
  setSkuArchived,
  updateSku,
} from '@/inventory/inventory-api';
import {
  SkuCodeForm,
  EditSkuForm,
  knownCode,
  skuEditMutationKey,
  skuEditValuesOf,
  type SkuLifecycleAction,
  type KnownCode,
  type CodeInput,
  type CodeOutput,
  type EditInput,
  type EditOutput,
} from './sku-edit-schema';

/** The loaded SKU form: name, price, code change, archive and delete, with stale record handling. */
export function SkuEditBody({
  sku: initial,
  fresh,
  onConfirmClose,
  reload,
  onClose,
  onDeleted,
}: {
  sku: SkuDetail;
  /** True once the query has fetched since this dialog opened (the cached copy may be older). */
  fresh: boolean;
  onConfirmClose: (close: (() => void) | null) => void;
  reload: () => Promise<SkuDetail | undefined>;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useMe();
  const isAdmin = me?.permissions.includes('catalog.manage') ?? false;
  // The version this dialog edits against. It is set on open, then by the first fresh fetch while
  // the form is untouched, then only by this dialog's own saves and Reload, never by the shared
  // query: a refetch from the detail page mid edit must not
  // swap `updatedAt` (or the diff base) under the person typing, or a save would overwrite a
  // colleague's change.
  const [sku, setSku] = useState(initial);
  const [failure, setFailure] = useState<KnownCode | 'generic' | null>(null);
  const [confirm, setConfirm] = useState<SkuLifecycleAction | null>(null);
  const [reloading, setReloading] = useState(false);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    if (confirm) {
      onConfirmClose(() => setConfirm(null));
      return;
    }
    const timer = window.setTimeout(() => {
      onConfirmClose(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [confirm, onConfirmClose]);

  const usage = useQuery({
    queryKey: inventoryKeys.skuUsage(sku.id),
    queryFn: ({ signal }) => getSkuUsage(sku.id, signal),
    enabled: isAdmin && !deleted,
  });

  const form = useForm<EditInput, unknown, EditOutput>({
    resolver: zodResolver(EditSkuForm),
    mode: 'onTouched',
    defaultValues: skuEditValuesOf(sku),
  });
  const codeForm = useForm<CodeInput, unknown, CodeOutput>({
    resolver: zodResolver(SkuCodeForm),
    mode: 'onTouched',
    defaultValues: { code: sku.code },
  });
  const { errors, isDirty } = form.formState;
  // The cached copy shown on open may predate the mount refetch: adopt that first fresh result as
  // the base, but only while untouched. Later refetches never move the base.
  const [adopted, setAdopted] = useState(fresh);
  const [adoptedSku, setAdoptedSku] = useState<SkuDetail | null>(null);
  if (!adopted && fresh) {
    setAdopted(true);
    if (!isDirty) {
      setSku(initial);
      setAdoptedSku(initial);
    }
  }
  useEffect(() => {
    if (!adoptedSku) return;
    form.reset(skuEditValuesOf(adoptedSku));
    codeForm.reset({ code: adoptedSku.code });
  }, [adoptedSku, form, codeForm]);
  const codeErrors = codeForm.formState.errors;

  const stored = (next: SkuDetail) => {
    queryClient.setQueryData(inventoryKeys.sku(next.id), next);
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.skus });
  };

  // A rename or code change shows in stock and receipt lines too.
  const storedEverywhere = (next: SkuDetail) => {
    stored(next);
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.stockAll });
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.receiptsRoot });
  };

  const save = useMutation({
    mutationKey: skuEditMutationKey(sku.id),
    mutationFn: (values: EditOutput) => {
      const nameChanged =
        values.nameEn !== (sku.name.en ?? '') || values.nameAr !== (sku.name.ar ?? '');
      const priceChanged = values.price !== (sku.price ?? '');
      return updateSku(sku.id, {
        updatedAt: sku.updatedAt,
        ...(nameChanged && { name: { en: values.nameEn, ar: values.nameAr } }),
        ...(priceChanged && { price: values.price === '' ? null : values.price }),
      });
    },
    onSuccess: (next) => {
      setSku(next);
      storedEverywhere(next);
      toast.success(t('inventory.skuEdit.saved', { code: next.code }));
      onClose();
    },
    onError: (error) => setFailure(knownCode(error)),
  });

  const recode = useMutation({
    mutationKey: skuEditMutationKey(sku.id),
    mutationFn: (values: CodeOutput) =>
      changeSkuCode(sku.id, { updatedAt: sku.updatedAt, sku: values.code }),
    onSuccess: (next) => {
      setSku(next);
      storedEverywhere(next);
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.skuUsage(next.id) });
      codeForm.reset({ code: next.code });
      setFailure(null);
      toast.success(t('inventory.skuEdit.codeSaved', { code: next.code }));
    },
    onError: (error) => {
      const code = knownCode(error);
      if (code === 'SKU_TAKEN' || code === 'STYLE_CODE_TAKEN') {
        codeForm.setError('code', { message: code }, { shouldFocus: true });
        return;
      }
      if (code === 'CODE_LOCKED') {
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.skuUsage(sku.id) });
      }
      setFailure(code);
    },
  });

  const act = useMutation({
    mutationKey: skuEditMutationKey(sku.id),
    mutationFn: (action: SkuLifecycleAction) =>
      action === 'delete'
        ? deleteSku(sku.id).then(() => null)
        : setSkuArchived(sku.id, action === 'archive'),
    onSuccess: (next, action) => {
      if (action === 'delete') {
        // Never refetch the gone record while the route still shows it (that flashes a 404).
        // With a detail page behind this dialog its observers stay mounted until the route
        // changes, so leave this SKU's own queries alone and refresh every other SKU query.
        // Without one, drop them.
        const ownId = sku.id;
        if (onDeleted) {
          void queryClient.invalidateQueries({
            queryKey: inventoryKeys.skus,
            predicate: (query) => query.queryKey.at(-1) !== ownId,
          });
        } else {
          for (const key of [
            inventoryKeys.sku(ownId),
            inventoryKeys.skuStock(ownId),
            inventoryKeys.skuMovements(ownId),
            inventoryKeys.skuUsage(ownId),
          ]) {
            queryClient.removeQueries({ queryKey: key, exact: true });
          }
          void queryClient.invalidateQueries({ queryKey: inventoryKeys.skus });
        }
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.stockAll });
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.receiptsRoot });
        toast.success(t('inventory.skuEdit.deleted', { code: sku.code }));
        if (onDeleted) {
          // Stay mounted (busy) until the route changes: a state change here would re-render the
          // detail page and rebuild the queries just removed.
          setDeleted(true);
          onDeleted();
        } else {
          setConfirm(null);
          onClose();
        }
        return;
      }
      if (next) {
        // Only the archive state moves: the rest of the form still holds what was read on open.
        setSku((current) => ({
          ...current,
          archived: next.archived,
          status: next.status,
          updatedAt: next.updatedAt,
        }));
        stored(next);
      }
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.skuUsage(sku.id) });
      toast.success(
        t(action === 'archive' ? 'inventory.skuEdit.archived' : 'inventory.skuEdit.unarchived', {
          code: sku.code,
        }),
      );
      setConfirm(null);
    },
    onError: (error) => {
      if (knownCode(error) === 'STOCK_ON_HAND') {
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.skuUsage(sku.id) });
      }
    },
  });

  const busy = save.isPending || recode.isPending;
  const codeLocked = !isAdmin || usage.data?.codeLocked !== false;
  const messageFor = (code: KnownCode | 'generic') => t(`inventory.skuEdit.errors.${code}`);
  const blocked = usage.data?.canArchive === false;

  const reloadLatest = async () => {
    setReloading(true);
    try {
      const latest = await reload();
      if (latest) {
        setSku(latest);
        form.reset(skuEditValuesOf(latest));
        codeForm.reset({ code: latest.code });
        setFailure(null);
      }
    } finally {
      setReloading(false);
    }
  };

  const confirmCopy: Record<
    SkuLifecycleAction,
    { title: string; description: string; label: string }
  > = {
    archive: {
      title: t('inventory.skuEdit.archiveTitle', { code: sku.code }),
      description: t('inventory.skuEdit.archiveDescription'),
      label: t('inventory.skuEdit.archive'),
    },
    unarchive: {
      title: t('inventory.skuEdit.unarchiveTitle', { code: sku.code }),
      description: t('inventory.skuEdit.unarchiveDescription'),
      label: t('inventory.skuEdit.unarchive'),
    },
    delete: {
      title: t('inventory.skuEdit.deleteTitle', { code: sku.code }),
      description: t('inventory.skuEdit.deleteDescription'),
      label: t('inventory.skuEdit.delete'),
    },
  };

  const openConfirm = (action: SkuLifecycleAction) => {
    act.reset();
    setConfirm(action);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('inventory.skuEdit.title', { code: sku.code })}</DialogTitle>
        <DialogDescription>{t('inventory.skuEdit.description')}</DialogDescription>
      </DialogHeader>

      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {messageFor(failure)}
            {failure === 'STALE_RECORD' && (
              <Button
                size="sm"
                variant="outline"
                disabled={reloading}
                onClick={() => void reloadLatest()}
              >
                {t('inventory.skuEdit.reload')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <form
        noValidate
        className="grid gap-6"
        onSubmit={(event) => {
          setFailure(null);
          void form.handleSubmit((values) => save.mutate(values))(event);
        }}
      >
        <FieldGroup className="gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={!!errors.nameEn}>
              <FieldLabel htmlFor="sku-edit-name-en">{t('inventory.sku.nameEn')}</FieldLabel>
              <Input
                id="sku-edit-name-en"
                lang="en"
                dir="ltr"
                autoComplete="off"
                aria-invalid={!!errors.nameEn}
                aria-describedby={errors.nameEn ? 'sku-edit-name-error' : 'sku-edit-name-hint'}
                {...form.register('nameEn')}
              />
            </Field>
            <Field data-invalid={!!errors.nameEn}>
              <FieldLabel htmlFor="sku-edit-name-ar">{t('inventory.sku.nameAr')}</FieldLabel>
              <Input
                id="sku-edit-name-ar"
                lang="ar"
                dir="rtl"
                autoComplete="off"
                aria-invalid={!!errors.nameEn}
                aria-describedby={errors.nameEn ? 'sku-edit-name-error' : 'sku-edit-name-hint'}
                {...form.register('nameAr')}
              />
            </Field>
          </div>
          {errors.nameEn ? (
            <FieldError id="sku-edit-name-error" className="-mt-2">
              {t('inventory.sku.errors.nameRequired')}
            </FieldError>
          ) : (
            <FieldDescription id="sku-edit-name-hint" className="-mt-2">
              {t('inventory.sku.nameHint')}
            </FieldDescription>
          )}

          <Field data-invalid={!!errors.price}>
            <FieldLabel htmlFor="sku-edit-price">
              {t('inventory.sku.price')}
              <span className="font-normal text-muted-foreground">({t('inventory.optional')})</span>
            </FieldLabel>
            <Input
              id="sku-edit-price"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              className="tabular-nums sm:max-w-48"
              aria-invalid={!!errors.price}
              aria-describedby={errors.price ? 'sku-edit-price-error' : 'sku-edit-price-hint'}
              {...form.register('price')}
            />
            {errors.price ? (
              <FieldError id="sku-edit-price-error">
                {t('inventory.sku.errors.priceInvalid')}
              </FieldError>
            ) : (
              <FieldDescription id="sku-edit-price-hint">
                {t('inventory.sku.priceHint')}
              </FieldDescription>
            )}
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t('inventory.cancel')}
          </Button>
          <Button type="submit" disabled={busy} aria-busy={save.isPending}>
            {save.isPending && (
              <LoaderCircleIcon
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            )}
            {t('inventory.skuEdit.save')}
          </Button>
        </DialogFooter>
      </form>

      {isAdmin && (
        <section aria-labelledby="sku-admin-title" className="grid gap-4 border-t pt-4">
          <h3 id="sku-admin-title" className="text-sm font-semibold">
            {t('inventory.skuEdit.adminTitle')}
          </h3>

          <form
            noValidate
            className="grid gap-2"
            onSubmit={(event) => {
              setFailure(null);
              void codeForm.handleSubmit((values) => {
                if (values.code !== sku.code) recode.mutate(values);
              })(event);
            }}
          >
            <Field data-invalid={!!codeErrors.code}>
              <FieldLabel htmlFor="sku-edit-code">{t('inventory.skuEdit.codeTitle')}</FieldLabel>
              <div className="flex flex-wrap items-start gap-2">
                <Input
                  id="sku-edit-code"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="characters"
                  className="min-w-40 flex-1 sm:max-w-64"
                  disabled={codeLocked}
                  aria-invalid={!!codeErrors.code}
                  aria-describedby={
                    codeErrors.code
                      ? 'sku-edit-code-error'
                      : usage.data?.codeLocked
                        ? 'sku-edit-code-locked'
                        : 'sku-edit-code-hint'
                  }
                  {...codeForm.register('code')}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={codeLocked || busy}
                  aria-busy={recode.isPending}
                >
                  {recode.isPending && (
                    <LoaderCircleIcon
                      aria-hidden
                      className="animate-spin motion-reduce:animate-none"
                      data-icon="inline-start"
                    />
                  )}
                  {t('inventory.skuEdit.codeChange')}
                </Button>
              </div>
              {codeErrors.code ? (
                <FieldError id="sku-edit-code-error">
                  {codeErrors.code.message === 'SKU_TAKEN'
                    ? t('inventory.skuEdit.errors.SKU_TAKEN')
                    : codeErrors.code.message === 'STYLE_CODE_TAKEN'
                      ? t('inventory.skuEdit.errors.STYLE_CODE_TAKEN')
                      : t('inventory.sku.errors.codeInvalid')}
                </FieldError>
              ) : usage.data?.codeLocked ? (
                <FieldDescription id="sku-edit-code-locked">
                  {t('inventory.skuEdit.codeLockedHint')}
                </FieldDescription>
              ) : (
                <FieldDescription id="sku-edit-code-hint">
                  {t('inventory.skuEdit.codeHint')}
                </FieldDescription>
              )}
            </Field>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            {sku.archived ? (
              <Button type="button" variant="outline" onClick={() => openConfirm('unarchive')}>
                {t('inventory.skuEdit.unarchive')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={blocked}
                aria-describedby={blocked ? 'sku-archive-blocked' : undefined}
                onClick={() => openConfirm('archive')}
              >
                {t('inventory.skuEdit.archive')}
              </Button>
            )}
            <Button type="button" variant="destructive" onClick={() => openConfirm('delete')}>
              {t('inventory.skuEdit.delete')}
            </Button>
          </div>
          {!sku.archived && blocked && (
            <p id="sku-archive-blocked" className="text-sm text-muted-foreground">
              {t('inventory.skuEdit.archiveBlocked')}
            </p>
          )}
        </section>
      )}

      {confirm && (
        <ConfirmActionDialog
          title={confirmCopy[confirm].title}
          description={confirmCopy[confirm].description}
          confirmLabel={confirmCopy[confirm].label}
          destructive={confirm === 'delete'}
          pending={act.isPending || deleted}
          error={act.error ? messageFor(knownCode(act.error)) : null}
          onConfirm={() => act.mutate(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
