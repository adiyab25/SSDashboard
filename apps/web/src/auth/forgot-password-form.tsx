'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { loadConfig } from '@/shell/client-config';
import { authClient } from './auth-client';

// Loose on purpose: the server decides what is a real address. This only catches a typo.
const LOOKS_LIKE_EMAIL = /^\S+@\S+\.\S+$/;

/**
 * Ask for a password reset link (spec 0005, AC-9, AC-10). With mail on, any email gets the same
 * neutral confirmation. With no mail on the install, the page says to ask an administrator and
 * sends nothing.
 */
export function ForgotPasswordForm() {
  const { t } = useTranslation();
  // undefined until the install's settings load; a failed load is treated as mail on.
  const [mailEnabled, setMailEnabled] = useState<boolean | undefined>(undefined);
  const [problem, setProblem] = useState<'required' | 'invalid' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    void loadConfig().then((config) => {
      if (active) setMailEnabled(config ? config.mailEnabled : true);
    });
    return () => {
      active = false;
    };
  }, []);

  // The confirmation replaces the form, so focus moves to its heading for screen readers.
  useEffect(() => {
    if (sent) headingRef.current?.focus();
  }, [sent]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const raw = new FormData(event.currentTarget).get('email');
    const email = (typeof raw === 'string' ? raw : '').trim();
    const found = !email ? 'required' : LOOKS_LIKE_EMAIL.test(email) ? null : 'invalid';
    setProblem(found);
    setFailure(null);
    if (found) {
      emailRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const { error } = await authClient().requestPasswordReset({
        email,
        redirectTo: '/reset-password',
      });
      if (error) {
        setFailure(error.status === 429 ? t('auth.forgot.rateLimited') : t('auth.forgot.failed'));
        setPending(false);
        return;
      }
      setSent(true);
    } catch {
      setFailure(t('auth.forgot.failed'));
    }
    setPending(false);
  }

  const back = (
    <Button asChild variant="link" className="self-start px-0">
      <Link href="/sign-in">{t('auth.forgot.backToSignIn')}</Link>
    </Button>
  );

  if (mailEnabled === false) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">{t('auth.forgot.mailOffTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('auth.forgot.mailOff')}</p>
        {back}
      </div>
    );
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          {t('auth.forgot.sentTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('auth.forgot.sent')}</p>
        {back}
      </div>
    );
  }

  const message =
    problem === 'required'
      ? t('auth.signIn.emailRequired')
      : problem === 'invalid'
        ? t('auth.signIn.emailInvalid')
        : null;

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby="forgot-title"
    >
      <FieldGroup className="gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 id="forgot-title" className="text-xl font-semibold">
            {t('auth.forgot.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('auth.forgot.description')}</p>
        </div>

        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}

        <Field data-invalid={problem ? true : undefined}>
          <FieldLabel htmlFor="forgot-email">
            {t('auth.forgot.email')}
            <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
          </FieldLabel>
          <Input
            ref={emailRef}
            id="forgot-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-required
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'forgot-email-error' : undefined}
          />
          <FieldError id="forgot-email-error">{message}</FieldError>
        </Field>

        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('auth.forgot.submit')}
        </Button>
        {back}
      </FieldGroup>
    </form>
  );
}
