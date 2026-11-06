'use client';

import { StaffName, StaffPhone, type Home, type MeResponse } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { LoaderCircleIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { updateProfile } from '@/auth/account-api';
import { CORE_LANGUAGES, isCoreLanguage } from '@ssdashboard/i18n';
import type { MessageKey } from '@ssdashboard/i18n';

const SELECT =
  'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-ring md:text-sm dark:bg-input/30';

const languageName = (code: string): string =>
  isCoreLanguage(code) ? CORE_LANGUAGES[code].nativeName : code;

interface Props {
  me: MeResponse;
  /** Language codes enabled on the install (`GET /api/config`). */
  languages: readonly string[];
  /** Whose page this is: a partner user sees their email only, never a role or a staff code. */
  audience: Home;
}

/**
 * Your details (AC-19): name, phone and language are yours to change. Email, role and staff code
 * are shown but not editable, because an administrator owns them; a partner user sees the email
 * only. The language saved here is the one every new sign in applies.
 */
export function ProfileSection({ me, languages, audience }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(me.name);
  const [phone, setPhone] = useState(me.phone ?? '');
  const [language, setLanguage] = useState(me.language ?? '');
  const [errors, setErrors] = useState<{ name?: MessageKey; phone?: MessageKey }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setSaved(false);
    setFailure(null);
    const found: { name?: MessageKey; phone?: MessageKey } = {};
    if (!StaffName.safeParse(name).success) found.name = 'account.profile.nameRequired';
    if (phone.trim() && !StaffPhone.safeParse(phone).success) {
      found.phone = 'account.profile.phoneInvalid';
    }
    setErrors(found);
    if (found.name) return void nameRef.current?.focus();
    if (found.phone) return void phoneRef.current?.focus();

    setPending(true);
    const result = await updateProfile({ name, phone, language }, audience);
    setPending(false);
    if (result.ok) {
      setSaved(true);
      return;
    }
    setFailure(
      result.code === 'INVALID_LANGUAGE'
        ? t('account.profile.INVALID_LANGUAGE')
        : t('account.profile.failed'),
    );
  }

  const readOnly: Array<[string, string, boolean]> = [
    [t('account.profile.email'), me.email, true],
    ...(audience === 'backoffice'
      ? ([
          [t('account.profile.role'), t(`shell.user.roles.${me.role}`), false],
          [
            t('account.profile.staffCode'),
            me.staffCode ?? t('account.profile.none'),
            Boolean(me.staffCode),
          ],
        ] satisfies Array<[string, string, boolean]>)
      : []),
  ];

  return (
    <section aria-labelledby="profile-title" className="flex flex-col gap-4">
      <h2 id="profile-title" className="text-base font-semibold">
        {t('account.profile.title')}
      </h2>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {readOnly.map(([label, value, code]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{code ? <LtrText>{value}</LtrText> : value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">
        {audience === 'backoffice'
          ? t('account.profile.readOnlyStaff')
          : t('account.profile.readOnly')}
      </p>

      <form method="post" noValidate onSubmit={(event) => void submit(event)}>
        <FieldGroup className="gap-4">
          {failure && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          <Field data-invalid={errors.name ? true : undefined}>
            <FieldLabel htmlFor="account-name">
              {t('account.profile.name')}
              <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
            </FieldLabel>
            <Input
              ref={nameRef}
              id="account-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              aria-required
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'account-name-error' : undefined}
              autoComplete="name"
            />
            <FieldError id="account-name-error">{errors.name ? t(errors.name) : null}</FieldError>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={errors.phone ? true : undefined}>
              <FieldLabel htmlFor="account-phone">{t('account.profile.phone')}</FieldLabel>
              <Input
                ref={phoneRef}
                id="account-phone"
                type="tel"
                dir="ltr"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                aria-invalid={errors.phone ? true : undefined}
                aria-describedby={errors.phone ? 'account-phone-error' : undefined}
                autoComplete="tel"
              />
              <FieldError id="account-phone-error">
                {errors.phone ? t(errors.phone) : null}
              </FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-language">{t('account.profile.language')}</FieldLabel>
              <select
                id="account-language"
                className={SELECT}
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option value="">{t('account.profile.languageDefault')}</option>
                {languages.map((code) => (
                  <option key={code} value={code}>
                    {languageName(code)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('account.profile.save')}
            </Button>
            <p role="status" className="text-sm text-muted-foreground">
              {saved ? t('account.profile.saved') : ''}
            </p>
          </div>
        </FieldGroup>
      </form>
    </section>
  );
}
