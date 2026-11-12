'use client';

import { refetchAfterWrite } from '@/api/refetch-after-write';
import { zodResolver } from '@hookform/resolvers/zod';
import { STOCK_COUNTED_CHECK_KEY, type LocationDetail } from '@ssdashboard/contracts';
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
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { useReturnFocus } from '@/shared/use-return-focus';
import {
  confirmLocationStock,
  getOnlineGate,
  inventoryKeys,
  makeLocationOnline,
  runGateAction,
} from './inventory-api';
import { HoldOpenOrdersResult } from './hold-open-orders-result';
import { OnlineGateCheckRow } from './online-gate-check-row';
import { OnlineReasonField } from './online-reason-field';
import { OnlineReasonForm } from './online-reason-form';

/** Api error codes the gate dialog has its own message for. */
const KNOWN = [
  'ONLINE_GATE_FAILED',
  'ONLINE_GATE_STALE',
  'ALREADY_ONLINE',
  'ONLINE_NEEDS_WAREHOUSE',
  'NOT_SELLABLE_ONLINE',
  'REASON_REQUIRED',
  'ALREADY_CONFIRMED',
] as const;
/** An api error code with its own message. */
type KnownCode = (typeof KNOWN)[number];

/** The code of an error when the dialog has a message for it, else `generic`. */
function errorCode(error: unknown): KnownCode | 'generic' {
  return error instanceof ApiError && (KNOWN as readonly string[]).includes(error.code)
    ? (error.code as KnownCode)
    : 'generic';
}

/** Api error codes a gate action has its own message for (spec 0013 AC-26). */
const ACTION_KNOWN = ['LOCATION_NOT_FOUND', 'BUSY'] as const;

/** The message of a failed gate action: its own sentence for a known code, else "try again". */
function actionErrorKey(error: unknown) {
  if (error instanceof ApiError && (ACTION_KNOWN as readonly string[]).includes(error.code)) {
    return `orders.onlineGate.errors.${error.code as (typeof ACTION_KNOWN)[number]}` as const;
  }
  return 'inventory.onlineGate.actionFailed' as const;
}

/**
 * The online gate of one warehouse (spec 0011 AC-19, AC-16): every check with its count, the fix
 * a failed check points to (run for this location, with the counts "Hold the open orders here"
 * answers), the built in "stock is counted" confirmation, the numbers the move
 * will change, and the move itself with a required written reason. The count sent is the one on
 * screen; when the numbers moved meanwhile (409 stale) or a check failed (409 failed) the gate is
 * read again and the person looks once more. It must never move the flag without that reason, and
 * the api enforces every rule again.
 */
export function OnlineGateDialog({
  location,
  onClose,
}: {
  location: LocationDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const gateKey = inventoryKeys.onlineGate(location.id);

  const gate = useQuery({
    queryKey: gateKey,
    queryFn: ({ signal }) => getOnlineGate(location.id, signal),
    staleTime: 0,
  });
  const view = gate.data;
  const reread = () => queryClient.invalidateQueries({ queryKey: gateKey });

  const form = useForm<OnlineReasonForm>({
    resolver: zodResolver(OnlineReasonForm),
    mode: 'onTouched',
    defaultValues: { reason: '' },
  });
  const { errors } = form.formState;

  const confirmStock = useMutation({
    mutationFn: () => confirmLocationStock(location.id),
    onSuccess: () => {
      toast.success(t('inventory.onlineGate.stockConfirmedDone', { code: location.code }));
      void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.locations });
      void reread();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ALREADY_CONFIRMED') void reread();
    },
  });

  const action = useMutation({
    mutationFn: (run: Parameters<typeof runGateAction>[0]) => runGateAction(run, location.id),
    onSettled: () => void reread(),
  });

  const move = useMutation({
    mutationFn: (values: OnlineReasonForm) =>
      makeLocationOnline(location.id, {
        confirmedVariantCount: view?.variantsWithStock ?? 0,
        reason: values.reason,
      }),
    onSuccess: () => {
      void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.locations });
      void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.onlineStatus });
      void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.stockAll });
      toast.success(t('inventory.onlineGate.movedDone', { code: location.code }));
      onClose();
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        (error.code === 'ONLINE_GATE_FAILED' ||
          error.code === 'ONLINE_GATE_STALE' ||
          error.code === 'ALREADY_ONLINE')
      ) {
        void reread();
      }
    },
  });

  const busy = confirmStock.isPending || action.isPending || move.isPending || gate.isFetching;
  const counted = view?.checks.find((check) => check.key === STOCK_COUNTED_CHECK_KEY);
  const allPassed = view?.checks.every((check) => check.passed) ?? false;
  const canMove = !!view && view.canGoOnline && allPassed;
  const failure = move.error ?? confirmStock.error;
  const name = text(location.name, location.code);
  const current = view?.currentOnlineLocation ?? null;

  const counts: { id: string; label: string; value: string }[] = view
    ? [
        {
          id: 'variantsWithStock',
          label: t('inventory.onlineGate.variantsWithStock'),
          value: format.number(view.variantsWithStock),
        },
        {
          id: 'totalOnHand',
          label: t('inventory.onlineGate.totalOnHand'),
          value: format.quantity(view.totalOnHand),
        },
        {
          id: 'variantsPushedZero',
          label: t('inventory.onlineGate.variantsPushedZero'),
          value: format.number(view.variantsPushedZero),
        },
      ]
    : [];

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        closeLabel={t('inventory.close')}
        onCloseAutoFocus={returnFocus}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
      >
        <form
          noValidate
          className="grid gap-5"
          onSubmit={(event) => void form.handleSubmit((values) => move.mutate(values))(event)}
        >
          <DialogHeader>
            <DialogTitle>{t('inventory.onlineGate.title', { code: location.code })}</DialogTitle>
            <DialogDescription>{t('inventory.onlineGate.description', { name })}</DialogDescription>
          </DialogHeader>

          {gate.isPending && (
            <div
              className="grid gap-2"
              role="status"
              aria-label={t('inventory.onlineGate.loading')}
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}

          {gate.isError && !view && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {t('inventory.onlineGate.loadError')}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void gate.refetch()}
                >
                  {t('inventory.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {view && (
            <>
              {!view.canGoOnline && allPassed && (
                <Alert role="status">
                  <AlertDescription>{t('inventory.onlineGate.cannotGoOnline')}</AlertDescription>
                </Alert>
              )}

              <section aria-labelledby="online-gate-checks" className="grid gap-2">
                <h3 id="online-gate-checks" className="text-sm font-semibold">
                  {t('inventory.onlineGate.checksHeading')}
                </h3>
                <ul className="grid gap-2">
                  {view.checks.map((check) => (
                    <OnlineGateCheckRow
                      key={check.key}
                      check={check}
                      running={action.isPending}
                      onRun={(run) => action.mutate(run)}
                    />
                  ))}
                </ul>
                {action.isError && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{t(actionErrorKey(action.error))}</AlertDescription>
                  </Alert>
                )}
                {action.data?.kind === 'held' && (
                  <HoldOpenOrdersResult result={action.data.result} />
                )}
                {counted && !counted.passed && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="self-start"
                    disabled={busy}
                    aria-busy={confirmStock.isPending}
                    onClick={() => confirmStock.mutate()}
                  >
                    {confirmStock.isPending && (
                      <LoaderCircleIcon
                        aria-hidden
                        className="animate-spin motion-reduce:animate-none"
                        data-icon="inline-start"
                      />
                    )}
                    {t('inventory.onlineGate.confirmStock')}
                  </Button>
                )}
              </section>

              <section aria-labelledby="online-gate-counts" className="grid gap-2">
                <h3 id="online-gate-counts" className="text-sm font-semibold">
                  {t('inventory.onlineGate.countsHeading')}
                </h3>
                <dl className="grid gap-1 text-sm">
                  {counts.map((row) => (
                    <div key={row.id} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="font-medium tabular-nums">{row.value}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">
                      {t('inventory.onlineGate.currentOnline')}
                    </dt>
                    <dd className="font-medium">
                      {current ? (
                        <>
                          <LtrText>{current.code}</LtrText> {text(current.name, current.code)}
                        </>
                      ) : (
                        t('inventory.onlineGate.currentNone')
                      )}
                    </dd>
                  </div>
                  {current && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">
                        {t('inventory.onlineGate.reservationsAtOldLocation', {
                          code: current.code,
                        })}
                      </dt>
                      <dd className="font-medium tabular-nums">
                        {format.number(view.reservationsAtOldLocation)}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>

              <OnlineReasonField
                id="online-gate-reason"
                invalid={!!errors.reason}
                register={form.register('reason')}
              />
              {!allPassed && (
                <p className="text-sm text-muted-foreground">
                  {t('inventory.onlineGate.passAllChecks')}
                </p>
              )}
            </>
          )}

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {t(`inventory.onlineGate.errors.${errorCode(failure)}`)}
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t('inventory.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !canMove} aria-busy={move.isPending}>
              {move.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('inventory.onlineGate.confirmMove')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
