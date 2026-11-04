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
import { CheckIcon, CopyIcon, LoaderCircleIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from '@/auth/auth-client';

type Dialog = 'enable' | 'disable' | 'codes' | null;

interface ClientError {
  status: number;
}

/** What a person is told for a refusal from the two factor routes. */
function useMessage() {
  const { t } = useTranslation();
  return (error: ClientError | null | undefined): string | null => {
    if (!error) return null;
    if (error.status === 400) return t('account.twoFactor.wrongPassword');
    if (error.status === 429) return t('account.twoFactor.rateLimited');
    return t('account.twoFactor.failed');
  };
}

/** The 10 backup codes, shown once, with a button that copies them. */
function BackupCodes({ codes }: { codes: readonly string[] }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      // The codes are on screen and selectable, so a failed copy costs nothing.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label={t('account.twoFactor.codes.label')}
        className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted px-3 py-2 font-mono text-sm select-all"
      >
        {codes.map((code) => (
          <li key={code}>
            <LtrText>{code}</LtrText>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => void copy()}>
          {copied ? (
            <CheckIcon aria-hidden data-icon="inline-start" />
          ) : (
            <CopyIcon aria-hidden data-icon="inline-start" />
          )}
          {copied ? t('account.twoFactor.codes.copied') : t('account.twoFactor.codes.copy')}
        </Button>
        <span role="status" className="sr-only">
          {copied ? t('account.twoFactor.codes.copied') : ''}
        </span>
      </div>
    </div>
  );
}

interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  id: string;
}

function PasswordField({ value, onChange, invalid, inputRef, id }: PasswordFieldProps) {
  const { t } = useTranslation();
  return (
    <Field data-invalid={invalid ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {t('account.twoFactor.password')}
        <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
      </FieldLabel>
      <Input
        ref={inputRef}
        id={id}
        type="password"
        autoComplete="current-password"
        required
        aria-required
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={`${id}-error`}>
        {invalid ? t('account.twoFactor.passwordRequired') : null}
      </FieldError>
    </Field>
  );
}

interface EnableProps {
  onEnabled: () => void;
  onClose: () => void;
}

/**
 * Turning on, one step at a time (spec 0005, AC-20): confirm the password, add the secret to an
 * authenticator app (a QR code, or the key to type), confirm the first code, and only then see
 * the backup codes. Closing early leaves two factor off: nothing counts until the code is right.
 */
function EnableDialog({ onEnabled, onClose }: EnableProps) {
  const { t } = useTranslation();
  const message = useMessage();
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
                className="rounded-md"
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

interface PasswordDialogProps {
  kind: 'disable' | 'codes';
  onDisabled: () => void;
  onClose: () => void;
}

/** Turning off, or making new backup codes: both need the password again (AC-20). */
function PasswordDialog({ kind, onDisabled, onClose }: PasswordDialogProps) {
  const { t } = useTranslation();
  const message = useMessage();
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

interface Props {
  enabled: boolean;
  /** Tells the page that two factor is now on or off, so it shows the right buttons. */
  onChange: (enabled: boolean) => void;
}

/**
 * Two factor sign in on your own account (AC-20): its state, and the three things you can do
 * about it. Turning on is a short step by step dialog; the rest ask for your password.
 */
export function TwoFactorSection({ enabled, onChange }: Props) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<Dialog>(null);

  return (
    <section aria-labelledby="two-factor-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="two-factor-title" className="text-base font-semibold">
          {t('account.twoFactor.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {enabled ? t('account.twoFactor.descriptionOn') : t('account.twoFactor.descriptionOff')}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">
          {enabled ? t('account.twoFactor.statusOn') : t('account.twoFactor.statusOff')}
        </span>
        {enabled ? (
          <>
            <Button variant="outline" onClick={() => setDialog('codes')}>
              {t('account.twoFactor.newCodes')}
            </Button>
            <Button variant="outline" onClick={() => setDialog('disable')}>
              {t('account.twoFactor.disable')}
            </Button>
          </>
        ) : (
          <Button onClick={() => setDialog('enable')}>{t('account.twoFactor.enable')}</Button>
        )}
      </div>

      {dialog === 'enable' && (
        <EnableDialog onEnabled={() => onChange(true)} onClose={() => setDialog(null)} />
      )}
      {(dialog === 'disable' || dialog === 'codes') && (
        <PasswordDialog
          kind={dialog}
          onDisabled={() => onChange(false)}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
