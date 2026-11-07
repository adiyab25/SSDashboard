'use client';

import type { StaffDetail, StaffHat } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
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
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { inCatalogOrder, startingCostView } from './cost-prefill';
import { HatsFieldset } from './hats-fieldset';
import { getStaff, replaceStaffAccess } from './staff-api';

/** The longest reason the api keeps (spec 0008, AC-13). */
const REASON_MAX = 500;

/** The refusals the dialog explains in its own words; anything else is the generic message. */
const KNOWN_ERRORS = new Set([
  'NO_HAT',
  'REASON_REQUIRED',
  'STALE_RECORD',
  'SELF_HAT_CHANGE',
  'LAST_ADMIN',
  'FORBIDDEN',
  'HAT_CONFLICT',
  'GRANT_NOT_ALLOWED',
  'NOT_FOUND',
]);

interface Props {
  /** The person whose hats change. Never the signed in person: the page offers no such action. */
  staffId: string;
  /** The person's name, for the title while their detail loads. */
  name: string;
  /** True when the signed in person holds `cost.view`, so they may move the cost switch. */
  canChangeCost: boolean;
  /** The control that opened the dialog (the row's actions button); focus goes back to it. */
  opener: HTMLElement | null;
  /** Called with the saved detail. */
  onSaved: (staff: StaffDetail) => void;
  onClose: () => void;
}

/**
 * The edit hats dialog of the people screen (spec 0008, AC-7, AC-12, AC-18): a checkbox per staff
 * hat with its description, the cost switch (prefilled by `startingCostView` until moved by
 * hand), and a reason that becomes required when Manager is taken away. Sends the whole new set
 * with the `updatedAt` read when it opened (`PUT /api/staff/:id/access`) and says every refusal in
 * plain words; a stale record offers a reload. It decides nothing the api does not decide again.
 */
export function StaffHatsDialog({ staffId, name, canChangeCost, opener, onSaved, onClose }: Props) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadCount, setLoadCount] = useState(0);
  const [hats, setHats] = useState<StaffHat[]>([]);
  const [costByHand, setCostByHand] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const [hatsError, setHatsError] = useState<MessageKey | null>(null);
  const [reasonError, setReasonError] = useState<MessageKey | null>(null);
  const [failure, setFailure] = useState<{ key: MessageKey; stale: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const firstHatRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  // The dialog edits what the person holds now, read fresh, with the `updatedAt` to send back.
  useEffect(() => {
    let active = true;
    void getStaff(staffId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      setDetail(result.data);
      setHats(inCatalogOrder(result.data.hats));
      setCostByHand(null);
    });
    return () => {
      active = false;
    };
  }, [staffId, loadCount]);

  const storedHats = detail ? inCatalogOrder(detail.hats) : [];
  const storedCostView = detail?.costView ?? false;
  const costView =
    costByHand ?? startingCostView({ hats, storedHats, storedCostView, canChange: canChangeCost });
  const removesManager = storedHats.includes('manager') && !hats.includes('manager');
  const loading = detail === null && !loadFailed;

  // Once the person's hats are on screen (first load or a reload), the first checkbox takes focus,
  // so the keyboard starts where the choices are rather than on Cancel.
  useEffect(() => {
    if (detail) firstHatRef.current?.focus();
  }, [detail]);

  // A refusal shown at the top takes focus, so a keyboard or screen reader user hears it at once.
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  function reload() {
    setFailure(null);
    setDetail(null);
    setReason('');
    setLoadCount((count) => count + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !detail) return;
    setFailure(null);
    const trimmed = reason.trim();
    const noHat: MessageKey | null = hats.length === 0 ? 'staff.hats.errors.NO_HAT' : null;
    const badReason: MessageKey | null =
      trimmed.length > REASON_MAX
        ? 'staff.hats.errors.REASON_TOO_LONG'
        : removesManager && !trimmed
          ? 'staff.hats.errors.REASON_REQUIRED'
          : null;
    setHatsError(noHat);
    setReasonError(badReason);
    if (noHat) {
      firstHatRef.current?.focus();
      return;
    }
    if (badReason) {
      reasonRef.current?.focus();
      return;
    }

    setPending(true);
    const result = await replaceStaffAccess(staffId, {
      hats,
      costView,
      updatedAt: detail.updatedAt,
      ...(trimmed && { reason: trimmed }),
    });
    if (result.ok) {
      onSaved(result.data);
      return;
    }
    setPending(false);
    if (result.code === 'NO_HAT') {
      setHatsError('staff.hats.errors.NO_HAT');
      firstHatRef.current?.focus();
    } else if (result.code === 'REASON_REQUIRED') {
      setReasonError('staff.hats.errors.REASON_REQUIRED');
      reasonRef.current?.focus();
    } else {
      const key = (
        KNOWN_ERRORS.has(result.code)
          ? `staff.hats.errors.${result.code}`
          : 'staff.hats.errors.generic'
      ) as MessageKey;
      setFailure({ key, stale: result.code === 'STALE_RECORD' });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('staff.setup.close')}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          if (opener?.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
      >
        <form
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>{t('staff.hats.title', { name: detail?.name ?? name })}</DialogTitle>
            <DialogDescription>{t('staff.hats.description')}</DialogDescription>
          </DialogHeader>

          {(failure || loadFailed) && (
            <Alert variant="destructive" ref={failureRef} tabIndex={-1}>
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {failure ? t(failure.key) : t('staff.hats.loadError')}
                {(failure?.stale || loadFailed) && (
                  <Button type="button" size="sm" variant="outline" onClick={reload}>
                    {t('staff.hats.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {loading ? (
            <div className="grid gap-3" aria-hidden>
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            detail && (
              <>
                <HatsFieldset
                  idPrefix="edit-hats"
                  hats={hats}
                  onHatsChange={(next) => {
                    setHats(next);
                    if (next.length > 0) setHatsError(null);
                  }}
                  costView={costView}
                  onCostViewChange={setCostByHand}
                  canChangeCost={canChangeCost}
                  error={hatsError ? t(hatsError) : null}
                  firstHatRef={firstHatRef}
                />
                <Field data-invalid={reasonError ? true : undefined}>
                  <FieldLabel htmlFor="edit-hats-reason">
                    {removesManager
                      ? t('staff.hats.reasonRequired')
                      : t('staff.hats.reasonOptional')}
                  </FieldLabel>
                  <Textarea
                    ref={reasonRef}
                    id="edit-hats-reason"
                    value={reason}
                    maxLength={REASON_MAX}
                    aria-required={removesManager || undefined}
                    aria-invalid={reasonError ? true : undefined}
                    aria-describedby={
                      reasonError
                        ? 'edit-hats-reason-hint edit-hats-reason-error'
                        : 'edit-hats-reason-hint'
                    }
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <FieldDescription id="edit-hats-reason-hint">
                    {t('staff.hats.reasonHint')}
                  </FieldDescription>
                  <FieldError id="edit-hats-reason-error">
                    {reasonError ? t(reasonError) : null}
                  </FieldError>
                </Field>
              </>
            )
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('staff.hats.cancel')}
            </Button>
            <Button type="submit" disabled={pending || !detail} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('staff.hats.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
