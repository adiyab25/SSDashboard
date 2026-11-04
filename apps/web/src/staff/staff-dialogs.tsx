'use client';

import type { StaffSetup } from '@ssdashboard/contracts';
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
import { Field, FieldLabel } from '@ssdashboard/ui/components/field';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { CheckIcon, CopyIcon, LoaderCircleIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

export type ConfirmKind = 'disable' | 'reset' | 'revoke';

interface ConfirmProps {
  kind: ConfirmKind;
  /** The person the action is for. */
  name: string;
  /** With mail on, a reset sends a link; otherwise it shows a temporary password. */
  mailEnabled: boolean;
  /** Runs the action; resolves to an error message, or null when it worked. */
  onConfirm: (reason: string) => Promise<string | null>;
  onClose: () => void;
}

/**
 * Confirms an action that is hard to undo (DESIGN.md: dialogs). The title says what happens and
 * the button names the action, never "OK". Disable can carry a reason.
 */
export function ConfirmDialog({ kind, name, mailEnabled, onConfirm, onClose }: ConfirmProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = {
    disable: {
      title: t('staff.confirm.disableTitle', { name }),
      body: t('staff.confirm.disableBody'),
      action: t('staff.confirm.disableConfirm'),
    },
    reset: {
      title: t('staff.confirm.resetTitle', { name }),
      body: mailEnabled ? t('staff.confirm.resetBodyMail') : t('staff.confirm.resetBodyTemporary'),
      action: t('staff.confirm.resetConfirm'),
    },
    revoke: {
      title: t('staff.confirm.revokeTitle', { name }),
      body: t('staff.confirm.revokeBody'),
      action: t('staff.confirm.revokeConfirm'),
    },
  }[kind];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const failure = await onConfirm(reason.trim());
    if (failure) {
      setError(failure);
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent closeLabel={t('staff.setup.close')}>
        <form onSubmit={(event) => void submit(event)} className="grid gap-6">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.body}</DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {kind === 'disable' && (
            <Field>
              <FieldLabel htmlFor="disable-reason">{t('staff.confirm.disableReason')}</FieldLabel>
              <Textarea
                id="disable-reason"
                value={reason}
                maxLength={300}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('staff.confirm.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {copy.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface SetupProps {
  /** What the admin sees: a temporary password to hand over, or a note that mail went out. */
  setup: StaffSetup;
  /** Whether this followed a new account or a password reset, for the email wording. */
  reason: 'invite' | 'reset';
  name: string;
  onClose: () => void;
}

/** Shows a temporary password once, or tells the admin an email is on its way (AC-12, AC-18). */
export function SetupDialog({ setup, reason, name, onClose }: SetupProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // The password is on screen and selectable, so a failed copy costs nothing.
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t('staff.setup.close')}>
        <DialogHeader>
          <DialogTitle>
            {setup.mode === 'temporary_password'
              ? t('staff.setup.temporaryTitle', { name })
              : t('staff.setup.title')}
          </DialogTitle>
          <DialogDescription>
            {setup.mode === 'temporary_password'
              ? t('staff.setup.temporaryBody')
              : reason === 'invite'
                ? t('staff.setup.emailInvite', { name })
                : t('staff.setup.emailReset', { name })}
          </DialogDescription>
        </DialogHeader>
        {setup.mode === 'temporary_password' && (
          <div className="flex flex-col gap-2">
            <span id="temporary-label" className="text-sm font-medium">
              {t('staff.setup.temporaryLabel')}
            </span>
            <div className="flex items-center gap-2">
              <code
                aria-labelledby="temporary-label"
                className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-base select-all"
              >
                <LtrText>{setup.temporaryPassword}</LtrText>
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={() => void copy(setup.temporaryPassword)}
              >
                {copied ? (
                  <CheckIcon aria-hidden data-icon="inline-start" />
                ) : (
                  <CopyIcon aria-hidden data-icon="inline-start" />
                )}
                {copied ? t('staff.setup.copied') : t('staff.setup.copy')}
              </Button>
            </div>
            <span role="status" className="sr-only">
              {copied ? t('staff.setup.copied') : ''}
            </span>
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t('staff.setup.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
