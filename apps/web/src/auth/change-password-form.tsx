'use client';

import { unmetPasswordRules } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LoaderCircleIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from './auth-client';
import { PasswordRules } from './password-rules';
import { safeReturnTo } from './return-to';

/**
 * The forced password change (spec 0005, AC-8, AC-14): a person who signed in with a temporary
 * password must choose their own before anything else works. Changing it ends their other
 * sessions, then the page they were going to opens.
 */
export function ChangePasswordForm() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [shown, setShown] = useState(false);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);

  const weak = touched && unmetPasswordRules(next).length > 0;
  const missingCurrent = touched && current.length === 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setTouched(true);
    setFailure(null);
    if (current.length === 0) {
      currentRef.current?.focus();
      return;
    }
    if (unmetPasswordRules(next).length > 0) {
      nextRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const { error } = await authClient().changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (!error) {
        // A full load, so the shell starts from the changed account with nothing from before.
        const returnTo = new URLSearchParams(window.location.search).get('returnTo');
        window.location.assign(safeReturnTo(returnTo, window.location.origin));
        return;
      }
      if (error.status === 400) setFailure(t('auth.changePassword.wrong'));
      else if (error.status === 422) setFailure(t('auth.reset.weak'));
      else if (error.status === 429) setFailure(t('auth.changePassword.rateLimited'));
      else setFailure(t('auth.changePassword.failed'));
    } catch {
      setFailure(t('auth.changePassword.failed'));
    }
    setPending(false);
  }

  async function signOut() {
    await authClient()
      .signOut()
      .catch(() => undefined);
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/sign-in');
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby="change-title"
    >
      <FieldGroup className="gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 id="change-title" className="text-xl font-semibold">
            {t('auth.changePassword.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('auth.changePassword.description')}</p>
        </div>

        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}

        <Field data-invalid={missingCurrent ? true : undefined}>
          <FieldLabel htmlFor="change-current">
            {t('auth.changePassword.current')}
            <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
          </FieldLabel>
          <Input
            ref={currentRef}
            id="change-current"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            aria-required
            aria-invalid={missingCurrent ? true : undefined}
            aria-describedby={missingCurrent ? 'change-current-error' : undefined}
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <FieldError id="change-current-error">
            {missingCurrent ? t('auth.changePassword.currentRequired') : null}
          </FieldError>
        </Field>

        <Field data-invalid={weak ? true : undefined}>
          <FieldLabel htmlFor="change-new">
            {t('auth.changePassword.new')}
            <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
          </FieldLabel>
          {/* Paste stays allowed, and `new-password` lets a password manager offer a strong one. */}
          <Input
            ref={nextRef}
            id="change-new"
            name="newPassword"
            type={shown ? 'text' : 'password'}
            autoComplete="new-password"
            required
            aria-required
            aria-invalid={weak ? true : undefined}
            aria-describedby={weak ? 'change-rules change-new-error' : 'change-rules'}
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <FieldError id="change-new-error">{weak ? t('auth.reset.weak') : null}</FieldError>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-0"
              aria-pressed={shown}
              onClick={() => setShown((value) => !value)}
            >
              {t('auth.reset.showPassword')}
            </Button>
          </div>
          <PasswordRules id="change-rules" password={next} />
        </Field>

        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('auth.changePassword.submit')}
        </Button>
        <Button
          type="button"
          variant="link"
          className="self-start px-0"
          onClick={() => void signOut()}
        >
          {t('auth.changePassword.signOut')}
        </Button>
      </FieldGroup>
    </form>
  );
}
