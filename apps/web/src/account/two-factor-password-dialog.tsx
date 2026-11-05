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
import { LoaderCircleIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from '@/auth/auth-client';
import { BackupCodes } from './backup-codes';
import { PasswordField } from './password-field';
import { useTwoFactorMessage } from './use-two-factor-message';

/** Props of `TwoFactorPasswordDialog`. */
interface PasswordDialogProps {
  kind: 'disable' | 'codes';
  onDisabled: () => void;
  onClose: () => void;
}

/** Turning off, or making new backup codes: both need the password again (AC-20). */
export function TwoFactorPasswordDialog({ kind, onDisabled, onClose }: PasswordDialogProps) {
  const { t } = useTranslation();
  const message = useTwoFactorMessage();
  const [password, setPassword] = useState('');
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const key = kind === 'disable' ? 'disableDialog' : 'newCodesDialog';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    setMissing(!password);
    if (!password) return void inputRef.current?.focus();
    setPending(true);
    try {
      const client = authClient().twoFactor;
      if (kind === 'disable') {
        const { error } = await client.disable({ password });
        if (error) setFailure(message(error));
        else {
          onDisabled();
          onClose();
          return;
        }
      } else {
        const { data, error } = await client.generateBackupCodes({ password });
        if (error || !data) setFailure(message(error ?? { status: 500 }));
        else {
          setCodes(data.backupCodes);
          setPassword('');
        }
      }
    } catch {
      setFailure(t('account.twoFactor.failed'));
    }
    setPending(false);
    if (kind === 'disable' || !codes) inputRef.current?.focus();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent closeLabel={t('account.twoFactor.close')}>
        <DialogHeader>
          <DialogTitle>{t(`account.twoFactor.${key}.title`)}</DialogTitle>
          <DialogDescription>
            {codes
              ? t('account.twoFactor.enableDialog.codesBody')
              : t(`account.twoFactor.${key}.body`)}
          </DialogDescription>
        </DialogHeader>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        {codes ? (
          <div className="grid gap-6">
            <BackupCodes codes={codes} />
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {t('account.twoFactor.newCodesDialog.done')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-6">
            <PasswordField
              id={`${kind}-password`}
              value={password}
              onChange={setPassword}
              invalid={missing}
              inputRef={inputRef}
            />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                {t('account.twoFactor.cancel')}
              </Button>
              <Button
                type="submit"
                variant={kind === 'disable' ? 'destructive' : 'default'}
                disabled={pending}
                aria-busy={pending}
              >
                {pending && (
                  <LoaderCircleIcon
                    aria-hidden
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                  />
                )}
                {t(`account.twoFactor.${key}.confirm`)}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
