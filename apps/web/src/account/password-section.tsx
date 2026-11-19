'use client';

import { unmetPasswordRules } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LoaderCircleIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from '@/auth/auth-client';
import { PasswordRules } from '@/auth/password-rules';

/**
 * Change your own password (AC-8, AC-19): the current password is needed, the new one follows the
 * shared rule, and the person's other sessions end. Unlike the forced change after a temporary
 * password, this stays on the page and says it worked.
 */
export function PasswordSection() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [shown, setShown] = useState(false);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);

  const weak = touched && unmetPasswordRules(next).length > 0;
  const missingCurrent = touched && current.length === 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setTouched(true);
    setDone(false);
    setFailure(null);
    if (current.length === 0) return void currentRef.current?.focus();
    if (unmetPasswordRules(next).length > 0) return void nextRef.current?.focus();

    setPending(true);
    try {
      const { error } = await authClient().changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (!error) {
        setDone(true);
        setCurrent('');
        setNext('');
        setTouched(false);
      } else if (error.status === 400) setFailure(t('auth.changePassword.wrong'));
      else if (error.status === 422) setFailure(t('auth.reset.weak'));
      else if (error.status === 429) setFailure(t('auth.changePassword.rateLimited'));
      else setFailure(t('auth.changePassword.failed'));
    } catch {
      setFailure(t('auth.changePassword.failed'));
    }
    setPending(false);
  }

  return (
    <section aria-labelledby="password-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="password-title" className="text-base font-semibold">
          {t('account.password.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('account.password.description')}</p>
      </div>
      <form method="post" noValidate onSubmit={(event) => void submit(event)}>
        <FieldGroup className="gap-4">
          {failure && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          <Field data-invalid={missingCurrent ? true : undefined}>
            <FieldLabel htmlFor="account-current">
              {t('auth.changePassword.current')}
              <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
            </FieldLabel>
            <Input
              ref={currentRef}
              id="account-current"
              type="password"
              autoComplete="current-password"
              required
              aria-required
              aria-invalid={missingCurrent ? true : undefined}
              aria-describedby={missingCurrent ? 'account-current-error' : undefined}
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
            <FieldError id="account-current-error">
              {missingCurrent ? t('auth.changePassword.currentRequired') : null}
            </FieldError>
          </Field>
          <Field data-invalid={weak ? true : undefined}>
            <FieldLabel htmlFor="account-new">
              {t('auth.changePassword.new')}
              <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
            </FieldLabel>
            <Input
              ref={nextRef}
              id="account-new"
              type={shown ? 'text' : 'password'}
              autoComplete="new-password"
              required
              aria-required
              aria-invalid={weak ? true : undefined}
              aria-describedby={weak ? 'account-rules account-new-error' : 'account-rules'}
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
            <FieldError id="account-new-error">{weak ? t('auth.reset.weak') : null}</FieldError>
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
            <PasswordRules id="account-rules" password={next} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" disabled={pending} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('auth.changePassword.submit')}
            </Button>
            <p role="status" className="text-sm text-muted-foreground">
              {done ? t('account.password.done') : ''}
            </p>
          </div>
        </FieldGroup>
      </form>
    </section>
  );
}
