'use client';

import { SignInErrorCode } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from './auth-client';
import { finishSignIn } from './finish-sign-in';

/** Better Auth's code for a missing, expired or already used challenge cookie (status 401). */
const CHALLENGE_ENDED = 'INVALID_TWO_FACTOR_COOKIE';

/**
 * The code step of a sign in (spec 0005, AC-20): after the password, a 6 digit code from the
 * authenticator app, or one of the backup codes. The password step has left only a short lived
 * challenge cookie, so a stopped or expired sign in says to start again. A wrong code counts toward
 * the same lock as a wrong password, and the lock answer looks like any wrong code.
 */
export function TwoFactorForm() {
  const { t } = useTranslation();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    const trimmed = code.trim();
    setProblem(!trimmed);
    if (!trimmed) {
      codeRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const client = authClient().twoFactor;
      const { error } = backup
        ? await client.verifyBackupCode({ code: trimmed })
        : await client.verifyTotp({ code: trimmed });
      if (!error) {
        const returnTo = new URLSearchParams(window.location.search).get('returnTo');
        const landing = await finishSignIn(returnTo, window.location.origin);
        // A full load, so the shell starts from the new session with no state from before.
        window.location.assign(landing);
        return;
      }
      if (error.status === 429) setFailure(t('auth.twoFactor.rateLimited'));
      else if (error.code === CHALLENGE_ENDED) setExpired(true);
      // The code was right but the account holds no hat (spec 0008): the api refuses the sign in,
      // and the attempt spent a backup code if one was used.
      else if (error.status === 403 && error.code === SignInErrorCode.enum.NO_ACCESS) {
        setFailure(t('auth.signIn.noAccess'));
      } else if (error.status === 401) {
        // A stopped challenge and a wrong code are both 401; the code tells them apart, and only
        // a wrong code can be tried again. A locked sign in answers like a wrong code.
        setFailure(backup ? t('auth.twoFactor.backupWrong') : t('auth.twoFactor.wrong'));
      } else setFailure(t('auth.twoFactor.failed'));
    } catch {
      setFailure(t('auth.twoFactor.failed'));
    }
    setPending(false);
    codeRef.current?.focus();
  }

  if (expired) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">{t('auth.twoFactor.expired')}</h1>
        <Button asChild size="lg">
          <Link href="/sign-in">{t('auth.twoFactor.startAgain')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby="two-factor-title"
    >
      <FieldGroup className="gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 id="two-factor-title" className="text-xl font-semibold">
            {backup ? t('auth.twoFactor.backupTitle') : t('auth.twoFactor.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {backup ? t('auth.twoFactor.backupDescription') : t('auth.twoFactor.description')}
          </p>
        </div>

        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}

        <Field data-invalid={problem ? true : undefined}>
          <FieldLabel htmlFor="two-factor-code">
            {backup ? t('auth.twoFactor.backupCode') : t('auth.twoFactor.code')}
            <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
          </FieldLabel>
          {/* Paste stays allowed. `one-time-code` lets a phone offer the code from a message or app. */}
          <Input
            key={backup ? 'backup' : 'app'}
            ref={codeRef}
            id="two-factor-code"
            name="code"
            dir="ltr"
            inputMode={backup ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-required
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'two-factor-code-error' : undefined}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <FieldError id="two-factor-code-error">
            {problem ? t('auth.twoFactor.codeRequired') : null}
          </FieldError>
        </Field>

        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('auth.twoFactor.submit')}
        </Button>
        <Button
          type="button"
          variant="link"
          className="self-start px-0"
          onClick={() => {
            setBackup((value) => !value);
            setCode('');
            setProblem(false);
            setFailure(null);
          }}
        >
          {backup ? t('auth.twoFactor.useApp') : t('auth.twoFactor.useBackup')}
        </Button>
      </FieldGroup>
    </form>
  );
}
