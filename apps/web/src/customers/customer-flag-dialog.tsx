'use client';

import {
  CUSTOMER_FLAG_NOTE_MAX,
  CustomerFlagReasonCode,
  CustomerRiskFlag,
  type CustomerProfile,
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Label } from '@ssdashboard/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@ssdashboard/ui/components/radio-group';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useFormat } from '@/i18n/use-format';
import { useReturnFocus } from '@/shared/use-return-focus';
import { customerKeys, setCustomerFlag } from './customers-api';
import { customerSelectClass } from './customer-select-class';
import { flagErrorKey, type FlagErrorKey } from './flag-error-key';

/** The reasons a person may pick by hand: `suggestion_applied` is kept for the one tap apply of a shown suggestion (AC-13). */
const MANUAL_REASONS = CustomerFlagReasonCode.exclude(['suggestion_applied']).options;

interface Props {
  /** The profile being flagged: its `updatedAt` is sent back as `expectedUpdatedAt`. */
  profile: CustomerProfile;
  onClose: () => void;
}

/**
 * The dialog that sets or changes a customer's flag (spec 0014, AC-11): a kind, an optional note
 * of at most 500 characters, and an optional reason code. Failures show inline with `role="alert"`
 * and never echo the note. A stale record reloads the profile and keeps what was typed, so the
 * person can check the profile and save again. Never logs or toasts the note.
 */
export function CustomerFlagDialog({ profile, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const returnFocus = useReturnFocus();
  const format = useFormat();
  const firstKind = useRef<HTMLButtonElement>(null);
  // The title it opened with: a reload after STALE_RECORD must not rename the open dialog.
  const [openedFlagged] = useState(profile.flag !== null);
  const [kind, setKind] = useState<CustomerRiskFlag | ''>(profile.flag?.kind ?? '');
  const [note, setNote] = useState(profile.flag?.note ?? '');
  const [reason, setReason] = useState<CustomerFlagReasonCode | ''>('');
  const [kindMissing, setKindMissing] = useState(false);
  const [error, setError] = useState<FlagErrorKey | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (kind === '') {
      setKindMissing(true);
      firstKind.current?.focus();
      return;
    }
    setKindMissing(false);
    setError(null);
    setPending(true);
    try {
      await setCustomerFlag(profile.id, {
        kind,
        note: note.trim() === '' ? null : note,
        ...(reason !== '' && { reasonCode: reason }),
        expectedUpdatedAt: profile.updatedAt,
      });
      toast.success(t('customers.flagging.set.saved'));
      await refetchAfterWrite(queryClient, { queryKey: customerKeys.all });
      onClose();
    } catch (failure) {
      setError(flagErrorKey(failure));
      // The profile may have moved on: reload it (the dialog and its input stay) so the next save is current.
      await refetchAfterWrite(queryClient, { queryKey: customerKeys.all }).catch(() => undefined);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('customers.flagging.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>
            {openedFlagged
              ? t('customers.flagging.set.changeTitle')
              : t('customers.flagging.set.title')}
          </DialogTitle>
          <DialogDescription>{t('customers.flagging.set.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('customers.flagging.set.kind')}</legend>
            <RadioGroup
              value={kind}
              onValueChange={(value) => setKind(CustomerRiskFlag.parse(value))}
              aria-invalid={kindMissing || undefined}
              aria-describedby={kindMissing ? 'flag-kind-error' : undefined}
              className="gap-2"
            >
              {CustomerRiskFlag.options.map((option, index) => (
                <div key={option} className="flex items-center gap-2">
                  <RadioGroupItem
                    ref={index === 0 ? firstKind : undefined}
                    value={option}
                    id={`flag-kind-${option}`}
                  />
                  <Label htmlFor={`flag-kind-${option}`}>{t(`customers.flag.${option}`)}</Label>
                </div>
              ))}
            </RadioGroup>
            <FieldError id="flag-kind-error" role="alert">
              {kindMissing ? t('customers.flagging.set.kindRequired') : null}
            </FieldError>
          </fieldset>
          <Field>
            <FieldLabel htmlFor="flag-note">{t('customers.flagging.set.note')}</FieldLabel>
            <Textarea
              id="flag-note"
              dir="auto"
              value={note}
              maxLength={CUSTOMER_FLAG_NOTE_MAX}
              aria-describedby="flag-note-hint"
              onChange={(event) => setNote(event.target.value)}
            />
            <FieldDescription id="flag-note-hint">
              {t('customers.flagging.set.noteHint', { max: format.number(CUSTOMER_FLAG_NOTE_MAX) })}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="flag-reason">{t('customers.flagging.set.reason')}</FieldLabel>
            <select
              id="flag-reason"
              className={customerSelectClass}
              value={reason}
              onChange={(event) => {
                const parsed = CustomerFlagReasonCode.safeParse(event.target.value);
                setReason(parsed.success ? parsed.data : '');
              }}
            >
              <option value="">{t('customers.flagging.set.reasonNone')}</option>
              {MANUAL_REASONS.map((code) => (
                <option key={code} value={code}>
                  {t(`customers.flagging.set.reasons.${code}`)}
                </option>
              ))}
            </select>
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
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {pending ? t('customers.flagging.saving') : t('customers.flagging.set.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
