'use client';

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
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { LoaderCircleIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

/** The hard to undo staff actions that ask for confirmation first. */
export type ConfirmKind = 'disable' | 'reset' | 'revoke' | 'twoFactor';

/** Props of `StaffConfirmDialog`. */
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
export function StaffConfirmDialog({ kind, name, mailEnabled, onConfirm, onClose }: ConfirmProps) {
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
    twoFactor: {
      title: t('staff.confirm.twoFactorTitle', { name }),
      body: t('staff.confirm.twoFactorBody'),
      action: t('staff.confirm.twoFactorConfirm'),
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
