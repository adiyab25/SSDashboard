'use client';

import { unmetPasswordRules } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from './auth-client';
import { PasswordRules } from './password-rules';
import { useFocusWhenShown } from './use-focus-when-shown';

type Stage =
  | { name: 'loading' }
  | { name: 'invalid' }
  | { name: 'form'; token: string; invite: boolean }
  | { name: 'done' };

const neverChanges = () => () => undefined;

/** The address bar's query string; null on the server, so the server markup is the same for everyone. */
function useQueryString(): string | null {
  return useSyncExternalStore(
    neverChanges,
    () => window.location.search,
    () => null,
  );
}

/** What the link says: dead, or a good token (with or without invite wording). */
function readLink(search: string | null): Stage {
  if (search === null) return { name: 'loading' };
  const params = new URLSearchParams(search);
  const token = params.get('token');
  if (params.get('error') || !token) return { name: 'invalid' };
  return { name: 'form', token, invite: params.get('invite') === '1' };
}

/**
 * Choose a password from a reset or invite link (spec 0005, AC-8, AC-9, AC-13). Better Auth's
 * token check has already redirected here with `?token=` for a good link or `?error=INVALID_TOKEN`
 * for a used or expired one, so a dead link is shown before the person types anything.
 * `?invite=1` only changes the wording.
 */
export function ResetPasswordForm() {
  const { t } = useTranslation();
  // The link decides the first screen; what happens after a save can replace it.
  const link = readLink(useQueryString());
  const [after, setAfter] = useState<'invalid' | 'done' | null>(null);
  const stage: Stage = after ? { name: after } : link;
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A new screen (dead link, done) replaces the form, so focus moves to its heading.
  useFocusWhenShown(headingRef, stage.name === 'invalid' || stage.name === 'done');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || stage.name !== 'form') return;
    setTouched(true);
    setFailure(null);
    if (unmetPasswordRules(password).length > 0) {
      inputRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const { error } = await authClient().resetPassword({
        newPassword: password,
        token: stage.token,
      });
      if (!error) {
        setAfter('done');
        return;
      }
      if (error.status === 400) setAfter('invalid');
      else if (error.status === 422) setFailure(t('auth.reset.weak'));
      else if (error.status === 429) setFailure(t('auth.reset.rateLimited'));
      else setFailure(t('auth.reset.failed'));
    } catch {
      setFailure(t('auth.reset.failed'));
    }
    setPending(false);
    inputRef.current?.focus();
  }

  if (stage.name === 'loading') return null;

  if (stage.name === 'invalid') {
    return (
      <div className="flex flex-col gap-3">
        <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          {t('auth.reset.invalidTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('auth.reset.invalidBody')}</p>
        <Button asChild size="lg">
          <Link href="/forgot-password">{t('auth.reset.requestNew')}</Link>
        </Button>
      </div>
    );
  }

  if (stage.name === 'done') {
    return (
      <div className="flex flex-col gap-3" role="status">
        <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          {t('auth.reset.doneTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('auth.reset.doneBody')}</p>
        <Button asChild size="lg">
          <Link href="/sign-in">{t('auth.reset.signIn')}</Link>
        </Button>
      </div>
    );
  }

  const invalid = touched && unmetPasswordRules(password).length > 0;

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby="reset-title"
    >
      <FieldGroup className="gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 id="reset-title" className="text-xl font-semibold">
            {stage.invite ? t('auth.reset.inviteTitle') : t('auth.reset.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {stage.invite ? t('auth.reset.inviteDescription') : t('auth.reset.description')}
          </p>
        </div>

        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}

        <Field data-invalid={invalid ? true : undefined}>
          <FieldLabel htmlFor="reset-password">
            {t('auth.reset.newPassword')}
            <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
          </FieldLabel>
          {/* Paste stays allowed, and `new-password` lets a password manager offer a strong one. */}
          <Input
            ref={inputRef}
            id="reset-password"
            name="password"
            type={shown ? 'text' : 'password'}
            autoComplete="new-password"
            required
            aria-required
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? 'reset-rules reset-password-error' : 'reset-rules'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <FieldError id="reset-password-error">{invalid ? t('auth.reset.weak') : null}</FieldError>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-0"
              aria-pressed={shown}
              onClick={() => setShown((current) => !current)}
            >
              {t('auth.reset.showPassword')}
            </Button>
          </div>
          <PasswordRules id="reset-rules" password={password} />
        </Field>

        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('auth.reset.submit')}
        </Button>
      </FieldGroup>
    </form>
  );
}
