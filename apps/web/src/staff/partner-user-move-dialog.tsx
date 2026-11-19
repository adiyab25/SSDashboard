'use client';

import type { PartnerAccount, PartnerUserDetail } from '@ssdashboard/contracts';
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
import { SELECT_CLASS } from '@/shared/select-class';
import { getPartnerUser, movePartnerUser } from './partner-users-api';

/** The longest reason the api keeps (spec 0008, AC-13). */
const REASON_MAX = 500;

/** The refusals the dialog explains in its own words; anything else is the generic message. */
const KNOWN_ERRORS = new Set(['STALE_RECORD', 'UNKNOWN_PARTNER_ACCOUNT', 'NOT_FOUND', 'FORBIDDEN']);

interface Props {
  /** The partner login that moves. */
  partnerUserId: string;
  /** The person's name, for the title while their detail loads. */
  name: string;
  /** The consignment partners a login can belong to. */
  accounts: readonly PartnerAccount[];
  /** The control that opened the dialog (the row's actions button); focus goes back to it. */
  opener: HTMLElement | null;
  /** Called with the saved detail. */
  onSaved: (partnerUser: PartnerUserDetail) => void;
  onClose: () => void;
}

/**
 * Moves a partner login to another partner account (spec 0008, AC-12, AC-15). It reads the login
 * fresh, asks for the new account and an optional reason, and sends them with the `updatedAt`
 * read when it opened (`PUT /api/partner-users/:id/access`); a stale record offers a reload. It
 * says plainly that the move signs the person out everywhere, and decides nothing the api does not
 * decide again.
 */
export function PartnerUserMoveDialog({
  partnerUserId,
  name,
  accounts,
  opener,
  onSaved,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<PartnerUserDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadCount, setLoadCount] = useState(0);
  const [accountId, setAccountId] = useState('');
  const [reason, setReason] = useState('');
  const [accountError, setAccountError] = useState<MessageKey | null>(null);
  const [reasonError, setReasonError] = useState<MessageKey | null>(null);
  const [failure, setFailure] = useState<{ key: MessageKey; stale: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const accountRef = useRef<HTMLSelectElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void getPartnerUser(partnerUserId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      setDetail(result.data);
      setAccountId('');
    });
    return () => {
      active = false;
    };
  }, [partnerUserId, loadCount]);

  const loading = detail === null && !loadFailed;
  const currentName = accounts.find((account) => account.id === detail?.partnerAccountId)?.name;

  // Once the login is on screen the account choice takes focus, so the keyboard starts there.
  useEffect(() => {
    if (detail) accountRef.current?.focus();
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
    const badAccount: MessageKey | null = !accountId
      ? 'staff.partners.form.accountRequired'
      : accountId === detail.partnerAccountId
        ? 'staff.partners.move.same'
        : null;
    const badReason: MessageKey | null =
      trimmed.length > REASON_MAX ? 'staff.partners.move.reasonTooLong' : null;
    setAccountError(badAccount);
    setReasonError(badReason);
    if (badAccount) {
      accountRef.current?.focus();
      return;
    }
    if (badReason) {
      reasonRef.current?.focus();
      return;
    }

    setPending(true);
    const result = await movePartnerUser(partnerUserId, {
      partnerAccountId: accountId,
      updatedAt: detail.updatedAt,
      ...(trimmed && { reason: trimmed }),
    });
    if (result.ok) {
      onSaved(result.data);
      return;
    }
    setPending(false);
    const key = (
      KNOWN_ERRORS.has(result.code)
        ? `staff.partners.errors.${result.code}`
        : 'staff.partners.errors.generic'
    ) as MessageKey;
    setFailure({ key, stale: result.code === 'STALE_RECORD' });
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
            <DialogTitle>
              {t('staff.partners.move.title', { name: detail?.name ?? name })}
            </DialogTitle>
            <DialogDescription>{t('staff.partners.move.description')}</DialogDescription>
          </DialogHeader>

          {(failure || loadFailed) && (
            <Alert variant="destructive" ref={failureRef} tabIndex={-1}>
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {failure ? t(failure.key) : t('staff.partners.move.loadError')}
                {(failure?.stale || loadFailed) && (
                  <Button type="button" size="sm" variant="outline" onClick={reload}>
                    {t('staff.partners.move.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {loading ? (
            <div className="grid gap-3" aria-hidden>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            detail && (
              <>
                <Field data-invalid={accountError ? true : undefined}>
                  <FieldLabel htmlFor="partner-move-account">
                    {t('staff.partners.move.account')}
                    <span className="font-normal text-muted-foreground">
                      ({t('auth.required')})
                    </span>
                  </FieldLabel>
                  <select
                    ref={accountRef}
                    id="partner-move-account"
                    className={SELECT_CLASS}
                    value={accountId}
                    required
                    aria-required
                    aria-invalid={accountError ? true : undefined}
                    aria-describedby={
                      accountError
                        ? 'partner-move-account-current partner-move-account-error'
                        : 'partner-move-account-current'
                    }
                    onChange={(event) => setAccountId(event.target.value)}
                  >
                    <option value="">{t('staff.partners.form.accountPick')}</option>
                    {accounts
                      .filter((account) => account.id !== detail.partnerAccountId)
                      .map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name} ({account.code})
                        </option>
                      ))}
                  </select>
                  <FieldDescription id="partner-move-account-current">
                    {t('staff.partners.move.current', {
                      account: currentName ?? t('staff.partners.account.unknown'),
                    })}
                  </FieldDescription>
                  <FieldError id="partner-move-account-error">
                    {accountError ? t(accountError) : null}
                  </FieldError>
                </Field>
                <Field data-invalid={reasonError ? true : undefined}>
                  <FieldLabel htmlFor="partner-move-reason">
                    {t('staff.partners.move.reason')}
                  </FieldLabel>
                  <Textarea
                    ref={reasonRef}
                    id="partner-move-reason"
                    value={reason}
                    maxLength={REASON_MAX}
                    aria-invalid={reasonError ? true : undefined}
                    aria-describedby={
                      reasonError
                        ? 'partner-move-reason-hint partner-move-reason-error'
                        : 'partner-move-reason-hint'
                    }
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <FieldDescription id="partner-move-reason-hint">
                    {t('staff.partners.move.reasonHint')}
                  </FieldDescription>
                  <FieldError id="partner-move-reason-error">
                    {reasonError ? t(reasonError) : null}
                  </FieldError>
                </Field>
              </>
            )
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('staff.partners.move.cancel')}
            </Button>
            <Button type="submit" disabled={pending || !detail} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('staff.partners.move.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
