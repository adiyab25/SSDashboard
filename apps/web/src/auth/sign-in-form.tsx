'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type FocusEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from './auth-client';
import { safeReturnTo } from './return-to';

type FieldName = 'email' | 'password';
type FieldErrors = Partial<Record<FieldName, 'required' | 'invalid'>>;

// Loose on purpose: the server decides what is a real address. This only catches a typo.
const LOOKS_LIKE_EMAIL = /^\S+@\S+\.\S+$/;

/** A form value as text; a file or a missing field counts as empty. */
const text = (value: FormDataEntryValue | null): string => (typeof value === 'string' ? value : '');

function check(name: FieldName, value: string): FieldErrors[FieldName] {
  if (name === 'email') {
    if (!value.trim()) return 'required';
    return LOOKS_LIKE_EMAIL.test(value.trim()) ? undefined : 'invalid';
  }
  return value ? undefined : 'required';
}

/** The sign in form (spec 0005, AC-1, AC-2, AC-8, AC-24): email and password, nothing else. */
export function SignInForm() {
  const { t } = useTranslation();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const messages: Record<FieldName, Record<'required' | 'invalid', string>> = {
    email: { required: t('auth.signIn.emailRequired'), invalid: t('auth.signIn.emailInvalid') },
    password: {
      required: t('auth.signIn.passwordRequired'),
      invalid: t('auth.signIn.passwordRequired'),
    },
  };

  // Shown after the person leaves a field, never while typing.
  function validateOnBlur(event: FocusEvent<HTMLInputElement>) {
    const name = event.currentTarget.name as FieldName;
    const problem = check(name, event.currentTarget.value);
    setErrors((current) => ({ ...current, [name]: problem }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const email = text(form.get('email')).trim();
    const password = text(form.get('password'));

    const found: FieldErrors = {
      email: check('email', email),
      password: check('password', password),
    };
    setErrors(found);
    setFailure(null);
    const firstInvalid = (['email', 'password'] as const).find((name) => found[name]);
    if (firstInvalid) {
      (firstInvalid === 'email' ? emailRef : passwordRef).current?.focus();
      return;
    }

    setPending(true);
    try {
      const { error } = await authClient().signIn.email({ email, password });
      if (error) {
        setFailure(failureMessage(error));
        setPending(false);
        return;
      }
      // A full load, so the shell starts from the new session with no state from before.
      const returnTo = new URLSearchParams(window.location.search).get('returnTo');
      window.location.assign(safeReturnTo(returnTo, window.location.origin));
    } catch {
      setFailure(t('auth.signIn.failed'));
      setPending(false);
    }
  }

  function failureMessage(error: { status: number; code?: string | undefined }): string {
    if (error.status === 403 && error.code === 'BANNED_USER') return t('auth.signIn.disabled');
    if (error.status === 429) return t('auth.signIn.rateLimited');
    if (error.status === 401) return t('auth.signIn.invalidCredentials');
    return t('auth.signIn.failed');
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby="sign-in-title"
    >
      <FieldGroup className="gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 id="sign-in-title" className="text-xl font-semibold">
            {t('auth.signIn.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('auth.signIn.description')}</p>
        </div>

        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}

        <Field data-invalid={errors.email ? true : undefined}>
          <FieldLabel htmlFor="sign-in-email">
            {t('auth.signIn.email')}
            <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
          </FieldLabel>
          <Input
            ref={emailRef}
            id="sign-in-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-required
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'sign-in-email-error' : undefined}
            onBlur={validateOnBlur}
          />
          <FieldError id="sign-in-email-error">
            {errors.email ? messages.email[errors.email] : null}
          </FieldError>
        </Field>

        <Field data-invalid={errors.password ? true : undefined}>
          <FieldLabel htmlFor="sign-in-password">
            {t('auth.signIn.password')}
            <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
          </FieldLabel>
          {/* Paste stays allowed and the right autocomplete value lets a password manager fill it. */}
          <Input
            ref={passwordRef}
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-required
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'sign-in-password-error' : undefined}
            onBlur={validateOnBlur}
          />
          <FieldError id="sign-in-password-error">
            {errors.password ? messages.password[errors.password] : null}
          </FieldError>
          <div>
            <Button asChild variant="link" size="sm" className="px-0">
              <Link href="/forgot-password">{t('auth.signIn.forgot')}</Link>
            </Button>
          </div>
        </Field>

        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('auth.signIn.submit')}
        </Button>
      </FieldGroup>
    </form>
  );
}
