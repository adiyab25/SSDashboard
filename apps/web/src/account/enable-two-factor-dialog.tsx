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
import { Field, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { LoaderCircleIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from '@/auth/auth-client';
import { BackupCodes } from './backup-codes';
import { PasswordField } from './password-field';
import { useTwoFactorMessage } from './use-two-factor-message';

/** Props of `EnableTwoFactorDialog`. */
interface EnableProps {
  onEnabled: () => void;
  onClose: () => void;
}

/**
 * Turning on, one step at a time (spec 0005, AC-20): confirm the password, add the secret to an
 * authenticator app (a QR code, or the key to type), confirm the first code, and only then see
 * the backup codes. Closing early leaves two factor off: nothing counts until the code is right.
 */
export function EnableTwoFactorDialog({ onEnabled, onClose }: EnableProps) {
  const { t } = useTranslation();
  const message = useTwoFactorMessage();
  const [step, setStep] = useState<'password' | 'scan' | 'codes'>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [uri, setUri] = useState('');
  const [codes, setCodes] = useState<readonly string[]>([]);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const secret = uri ? (new URL(uri).searchParams.get('secret') ?? '') : '';

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    setMissing(!password);
    if (!password) return void passwordRef.current?.focus();
    setPending(true);
    try {
      const { data, error } = await authClient().twoFactor.enable({ password });
      if (error || !data || !('totpURI' in data)) {
        setFailure(message(error ?? { status: 500 }));
      } else {
        setUri(data.totpURI);
        setCodes(data.backupCodes);
        setPassword('');
        setStep('scan');
      }
    } catch {
      setFailure(t('account.twoFactor.failed'));
    }
    setPending(false);
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    setMissing(!code.trim());
    if (!code.trim()) return void codeRef.current?.focus();
    setPending(true);
    try {
      const { error } = await authClient().twoFactor.verifyTotp({ code: code.trim() });
      if (error) {
        setFailure(
          error.status === 401 ? t('account.twoFactor.enableDialog.wrongCode') : message(error),
        );
        codeRef.current?.focus();
      } else {
        // Confirmed: two factor is on now, and the backup codes are shown for the only time.
        onEnabled();
        setStep('codes');
      }
    } catch {
      setFailure(t('account.twoFactor.failed'));
    }
    setPending(false);
  }

  const title =
    step === 'codes'
      ? t('account.twoFactor.enableDialog.codesTitle')
      : step === 'scan'
        ? t('account.twoFactor.enableDialog.scanTitle')
        : t('account.twoFactor.enableDialog.title');

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent closeLabel={t('account.twoFactor.close')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {step === 'password' && t('account.twoFactor.enableDialog.passwordBody')}
            {step === 'scan' && t('account.twoFactor.enableDialog.scanBody')}
            {step === 'codes' && t('account.twoFactor.enableDialog.codesBody')}
          </DialogDescription>
        </DialogHeader>

        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}

        {step === 'password' && (
          <form noValidate onSubmit={(event) => void submitPassword(event)} className="grid gap-6">
            <PasswordField
              id="enable-password"
              value={password}
              onChange={setPassword}
              invalid={missing}
              inputRef={passwordRef}
            />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                {t('account.twoFactor.cancel')}
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending && (
                  <LoaderCircleIcon
                    aria-hidden
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                  />
                )}
                {t('account.twoFactor.enableDialog.next')}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'scan' && (
          <form noValidate onSubmit={(event) => void submitCode(event)} className="grid gap-6">
            <div className="flex flex-col items-center gap-3">
              {/* Black on white whatever the theme, so every authenticator app can read it. */}
              <QRCodeSVG
                value={uri}
                size={176}
                marginSize={2}
                bgColor="#ffffff"
                fgColor="#000000"
                role="img"
                aria-label={t('account.twoFactor.enableDialog.qrLabel')}
                className="rounded-control"
              />
              <div className="flex flex-col items-center gap-1 text-sm">
                <span id="setup-key-label" className="text-muted-foreground">
                  {t('account.twoFactor.enableDialog.keyLabel')}
                </span>
                <code aria-labelledby="setup-key-label" className="font-mono break-all select-all">
                  <LtrText>{secret.match(/.{1,4}/g)?.join(' ') ?? secret}</LtrText>
                </code>
              </div>
            </div>
            <Field data-invalid={missing ? true : undefined}>
              <FieldLabel htmlFor="enable-code">
                {t('account.twoFactor.enableDialog.code')}
                <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
              </FieldLabel>
              <Input
                ref={codeRef}
                id="enable-code"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                aria-required
                aria-invalid={missing ? true : undefined}
                aria-describedby={missing ? 'enable-code-error' : undefined}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <FieldError id="enable-code-error">
                {missing ? t('account.twoFactor.enableDialog.codeRequired') : null}
              </FieldError>
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                {t('account.twoFactor.cancel')}
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending && (
                  <LoaderCircleIcon
                    aria-hidden
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                  />
                )}
                {t('account.twoFactor.enableDialog.verify')}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'codes' && (
          <div className="grid gap-6">
            <BackupCodes codes={codes} />
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {t('account.twoFactor.enableDialog.done')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
