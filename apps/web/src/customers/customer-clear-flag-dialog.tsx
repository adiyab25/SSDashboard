'use client';

import { CustomerUnflagReasonCode, type CustomerProfile } from '@ssdashboard/contracts';
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
import { Field, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useReturnFocus } from '@/shared/use-return-focus';
import { clearCustomerFlag, customerKeys } from './customers-api';
import { customerSelectClass } from './customer-select-class';
import { flagErrorKey, type FlagErrorKey } from './flag-error-key';

interface Props {
  /** The profile whose flag is cleared: its `updatedAt` is sent back as `expectedUpdatedAt`. */
  profile: CustomerProfile;
  onClose: () => void;
  /** Where focus goes after a successful clear, because the Clear flag opener is then gone. */
  focusAfterClear: RefObject<HTMLElement | null>;
}

/**
 * The dialog that clears a customer's flag (spec 0014, AC-11): the reason code is required. A
 * failure shows inline with `role="alert"`; a stale record reloads the profile and keeps the
 * dialog open so the person can check and try again.
 */
export function CustomerClearFlagDialog({ profile, onClose, focusAfterClear }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const returnFocus = useReturnFocus();
  const [reason, setReason] = useState<CustomerUnflagReasonCode | ''>('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [error, setError] = useState<FlagErrorKey | null>(null);
  const [pending, setPending] = useState(false);
  const cleared = useRef(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (reason === '') {
      setReasonMissing(true);
      return;
    }
    setReasonMissing(false);
    setError(null);
    setPending(true);
    try {
      await clearCustomerFlag(profile.id, {
        reasonCode: reason,
        expectedUpdatedAt: profile.updatedAt,
      });
      toast.success(t('customers.flagging.clear.done'));
      await refetchAfterWrite(queryClient, { queryKey: customerKeys.all });
      cleared.current = true;
      onClose();
    } catch (failure) {
      setError(flagErrorKey(failure));
      await refetchAfterWrite(queryClient, { queryKey: customerKeys.all }).catch(() => undefined);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('customers.flagging.close')}
        onCloseAutoFocus={(event) => {
          if (cleared.current && focusAfterClear.current?.isConnected) {
            event.preventDefault();
            focusAfterClear.current.focus();
          } else {
            returnFocus(event);
          }
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t('customers.flagging.clear.title')}</DialogTitle>
          <DialogDescription>{t('customers.flagging.clear.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          <Field data-invalid={reasonMissing ? true : undefined}>
            <FieldLabel htmlFor="unflag-reason">{t('customers.flagging.clear.reason')}</FieldLabel>
            <select
              id="unflag-reason"
              className={customerSelectClass}
              value={reason}
              aria-invalid={reasonMissing || undefined}
              aria-describedby={reasonMissing ? 'unflag-reason-error' : undefined}
              onChange={(event) => {
                const parsed = CustomerUnflagReasonCode.safeParse(event.target.value);
                setReason(parsed.success ? parsed.data : '');
              }}
            >
              <option value="">{t('customers.flagging.clear.reasonPlaceholder')}</option>
              {CustomerUnflagReasonCode.options.map((code) => (
                <option key={code} value={code}>
                  {t(`customers.flagging.clear.reasons.${code}`)}
                </option>
              ))}
            </select>
            <FieldError id="unflag-reason-error" role="alert">
              {reasonMissing ? t('customers.flagging.clear.reasonRequired') : null}
            </FieldError>
          </Field>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('customers.flagging.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {pending ? t('customers.flagging.saving') : t('customers.flagging.clear.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
