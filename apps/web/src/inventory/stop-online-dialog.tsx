'use client';

import { refetchAfterWrite } from '@/api/refetch-after-write';
import { zodResolver } from '@hookform/resolvers/zod';
import type { LocationDetail } from '@ssdashboard/contracts';
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useReturnFocus } from '@/shared/use-return-focus';
import { inventoryKeys, stopOnlineStock } from './inventory-api';
import { OnlineReasonField } from './online-reason-field';
import { OnlineReasonForm } from './online-reason-form';

/** Api error codes the stop dialog has its own message for. */
const KNOWN = ['NO_ONLINE_LOCATION', 'REASON_REQUIRED'] as const;

/**
 * Stops online stock (spec 0011 AC-19): after this no location feeds Shopify until a gate is
 * passed again. A written reason is required; the api enforces it too and audits the stop.
 */
export function StopOnlineDialog({
  location,
  onClose,
}: {
  location: LocationDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const form = useForm<OnlineReasonForm>({
    resolver: zodResolver(OnlineReasonForm),
    mode: 'onTouched',
    defaultValues: { reason: '' },
  });
  const { errors } = form.formState;

  const refresh = () => {
    void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.locations });
    void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.onlineStatus });
    void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.stockAll });
  };

  const stop = useMutation({
    mutationFn: (values: OnlineReasonForm) => stopOnlineStock(values.reason),
    onSuccess: () => {
      refresh();
      toast.success(t('inventory.onlineGate.stoppedDone', { code: location.code }));
      onClose();
    },
    onError: (error) => {
      // Someone stopped it first: the list behind the dialog should say so.
      if (error instanceof ApiError && error.code === 'NO_ONLINE_LOCATION') refresh();
    },
  });
  const code =
    stop.error instanceof ApiError && (KNOWN as readonly string[]).includes(stop.error.code)
      ? (stop.error.code as (typeof KNOWN)[number])
      : 'generic';

  return (
    <Dialog open onOpenChange={(open) => !open && !stop.isPending && onClose()}>
      <DialogContent
        closeLabel={t('inventory.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-lg"
      >
        <form
          noValidate
          className="grid gap-5"
          onSubmit={(event) => void form.handleSubmit((values) => stop.mutate(values))(event)}
        >
          <DialogHeader>
            <DialogTitle>
              {t('inventory.onlineGate.stopTitle', { code: location.code })}
            </DialogTitle>
            <DialogDescription>{t('inventory.onlineGate.stopDescription')}</DialogDescription>
          </DialogHeader>
          {stop.error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(`inventory.onlineGate.stopErrors.${code}`)}</AlertDescription>
            </Alert>
          )}
          <OnlineReasonField
            id="stop-online-reason"
            invalid={!!errors.reason}
            register={form.register('reason')}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={stop.isPending} onClick={onClose}>
              {t('inventory.cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={stop.isPending}
              aria-busy={stop.isPending}
            >
              {stop.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('inventory.onlineGate.stopConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
