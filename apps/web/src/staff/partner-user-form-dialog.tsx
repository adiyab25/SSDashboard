'use client';

import {
  CreatePartnerUserRequest,
  type CreatePartnerUserResponse,
  type PartnerAccount,
  type PartnerUserDetail,
} from '@ssdashboard/contracts';
import { CORE_LANGUAGES, isCoreLanguage, type MessageKey } from '@ssdashboard/i18n';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SELECT_CLASS } from '@/shared/select-class';
import { createPartnerUser, getPartnerUser, updatePartnerUser } from './partner-users-api';

type FieldName = 'name' | 'email' | 'account' | 'phone';

/** The order problems are focused in: the order the fields are drawn. */
const FIELD_ORDER = ['name', 'email', 'account', 'phone'] as const;

interface Values {
  name: string;
  email: string;
  phone: string;
  language: string;
  partnerAccountId: string;
}

const EMPTY: Values = { name: '', email: '', phone: '', language: '', partnerAccountId: '' };

interface Props {
  /** The login to edit, or null to add one. */
  editId: string | null;
  /** The consignment partners a login can belong to, for the picker and the account's name. */
  accounts: readonly PartnerAccount[];
  /** Language codes enabled on the install (`GET /api/config`). */
  languages: readonly string[];
  /**
   * Called after a save. A new login also hands back how the person gets their password.
   * `emailChanged` is true when the email of an invited login was changed by this save.
   */
  onSaved: (result: {
    partnerUser: PartnerUserDetail;
    created?: CreatePartnerUserResponse['setup'];
    emailChanged?: boolean;
  }) => void;
  onClose: () => void;
}

const languageName = (code: string): string =>
  isCoreLanguage(code) ? CORE_LANGUAGES[code].nativeName : code;

/**
 * Add or edit one partner login (spec 0008, AC-15). Adding picks the partner account the login
 * belongs to (required); editing changes details only, the account is shown but moves only
 * through the move dialog (`PUT /api/partner-users/:id/access`). The email is locked once the
 * person has signed in. It gives no hats and no cost switch: a partner login has neither.
 */
export function PartnerUserFormDialog({ editId, accounts, languages, onSaved, onClose }: Props) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Values>(EMPTY);
  const [detail, setDetail] = useState<PartnerUserDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const accountRef = useRef<HTMLSelectElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  const creating = editId === null;

  // Editing needs the fields the list does not carry (phone, language).
  useEffect(() => {
    if (editId === null) return;
    let active = true;
    void getPartnerUser(editId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setLoadFailed(true);
        return;
      }
      setDetail(result.data);
      setValues({
        name: result.data.name,
        email: result.data.email,
        phone: result.data.phone ?? '',
        language: result.data.language ?? '',
        partnerAccountId: result.data.partnerAccountId,
      });
    });
    return () => {
      active = false;
    };
  }, [editId, reloads]);

  const loading = editId !== null && detail === null && !loadFailed;
  // A failed load leaves the fields empty: they stay shut, so Save can never clear a phone.
  const blocked = loading || loadFailed;
  const emailLocked = detail !== null && detail.status !== 'invited';
  // An archived account, or an accounts list that failed, still gets a plain label.
  const accountName = loading
    ? ''
    : (accounts.find((account) => account.id === values.partnerAccountId)?.name ??
      t('staff.partners.account.unknown'));
  const set = (name: keyof Values) => (value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  function focusField(name: FieldName) {
    const target = { name: nameRef, email: emailRef, account: accountRef, phone: phoneRef }[name];
    target.current?.focus();
  }

  function validate(): Partial<Record<FieldName, MessageKey>> {
    const parsed = CreatePartnerUserRequest.safeParse({
      name: values.name,
      email: values.email,
      partnerAccountId: values.partnerAccountId || undefined,
      ...(values.phone.trim() && { phone: values.phone }),
    });
    const found: Partial<Record<FieldName, MessageKey>> = {};
    if (parsed.success) return found;
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === 'name') found.name ??= 'staff.form.nameRequired';
      else if (field === 'email') {
        found.email ??= values.email.trim()
          ? 'staff.form.emailInvalid'
          : 'staff.form.emailRequired';
      } else if (field === 'partnerAccountId' && creating) {
        found.account ??= 'staff.partners.form.accountRequired';
      } else if (field === 'phone') found.phone ??= 'staff.form.phoneInvalid';
    }
    return found;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || blocked) return;
    setFailure(null);
    const found = validate();
    setErrors(found);
    const first = FIELD_ORDER.find((name) => found[name]);
    if (first) {
      focusField(first);
      return;
    }

    setPending(true);
    // A new login only sends what was filled in (empty text would be refused); an edit sends
    // empty text to clear a field, and never the partner account.
    const result =
      editId === null
        ? await createPartnerUser({
            name: values.name,
            email: values.email,
            partnerAccountId: values.partnerAccountId,
            ...(values.phone.trim() && { phone: values.phone }),
            ...(values.language.trim() && { language: values.language }),
          })
        : await updatePartnerUser(editId, {
            name: values.name,
            phone: values.phone,
            language: values.language,
            ...(!emailLocked && { email: values.email }),
          });
    if (result.ok) {
      const emailChanged =
        editId !== null &&
        detail?.status === 'invited' &&
        values.email.trim().toLowerCase() !== detail.email.trim().toLowerCase();
      onSaved(
        'partnerUser' in result.data
          ? { partnerUser: result.data.partnerUser, created: result.data.setup }
          : { partnerUser: result.data, ...(emailChanged && { emailChanged }) },
      );
      return;
    }
    setPending(false);
    if (result.code === 'EMAIL_TAKEN') {
      setErrors({ email: 'staff.partners.errors.EMAIL_TAKEN' });
      focusField('email');
    } else if (result.code === 'UNKNOWN_PARTNER_ACCOUNT') {
      setErrors({ account: 'staff.partners.errors.UNKNOWN_PARTNER_ACCOUNT' });
      focusField('account');
    } else {
      const known = `staff.partners.errors.${result.code}` as MessageKey;
      setFailure(t(known, { defaultValue: t('staff.partners.errors.generic') }));
    }
  }

  const invalid = (name: FieldName) => (errors[name] ? true : undefined);

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('staff.setup.close')}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <form
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>
              {creating ? t('staff.partners.form.createTitle') : t('staff.partners.form.editTitle')}
            </DialogTitle>
            <DialogDescription>{t('staff.partners.form.description')}</DialogDescription>
          </DialogHeader>

          {(failure || loadFailed) && (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {failure ?? t('staff.partners.form.loadError')}
                {loadFailed && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLoadFailed(false);
                      setReloads((count) => count + 1);
                    }}
                  >
                    {t('staff.partners.form.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <Field data-invalid={invalid('name')}>
              <FieldLabel htmlFor="partner-user-name">
                {t('staff.form.name')}
                <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
              </FieldLabel>
              <Input
                ref={nameRef}
                id="partner-user-name"
                value={values.name}
                onChange={(event) => set('name')(event.target.value)}
                disabled={blocked}
                required
                aria-required
                aria-invalid={invalid('name')}
                aria-describedby={errors.name ? 'partner-user-name-error' : undefined}
                autoComplete="off"
              />
              <FieldError id="partner-user-name-error">
                {errors.name ? t(errors.name) : null}
              </FieldError>
            </Field>

            <Field data-invalid={invalid('email')}>
              <FieldLabel htmlFor="partner-user-email">
                {t('staff.form.email')}
                <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
              </FieldLabel>
              <Input
                ref={emailRef}
                id="partner-user-email"
                type="email"
                inputMode="email"
                dir="ltr"
                value={values.email}
                onChange={(event) => set('email')(event.target.value)}
                disabled={blocked || emailLocked}
                required
                aria-required
                aria-invalid={invalid('email')}
                aria-describedby={
                  errors.email
                    ? 'partner-user-email-error'
                    : emailLocked
                      ? 'partner-user-email-help'
                      : undefined
                }
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="off"
              />
              {emailLocked && (
                <FieldDescription id="partner-user-email-help">
                  {t('staff.form.emailLocked')}
                </FieldDescription>
              )}
              <FieldError id="partner-user-email-error">
                {errors.email ? t(errors.email) : null}
              </FieldError>
            </Field>

            <Field data-invalid={invalid('account')}>
              <FieldLabel htmlFor="partner-user-account">
                {t('staff.partners.form.account')}
                {creating && (
                  <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
                )}
              </FieldLabel>
              {creating ? (
                <select
                  ref={accountRef}
                  id="partner-user-account"
                  className={SELECT_CLASS}
                  value={values.partnerAccountId}
                  required
                  aria-required
                  aria-invalid={invalid('account')}
                  aria-describedby={
                    errors.account
                      ? 'partner-user-account-error'
                      : accounts.length === 0
                        ? 'partner-user-account-none'
                        : undefined
                  }
                  onChange={(event) => set('partnerAccountId')(event.target.value)}
                >
                  <option value="">{t('staff.partners.form.accountPick')}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.code})
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <Input
                    id="partner-user-account"
                    value={accountName}
                    readOnly
                    disabled={blocked}
                    aria-describedby="partner-user-account-help"
                  />
                  <FieldDescription id="partner-user-account-help">
                    {t('staff.partners.form.accountLocked')}
                  </FieldDescription>
                </>
              )}
              {creating && accounts.length === 0 && (
                <FieldDescription id="partner-user-account-none">
                  {t('staff.partners.account.none')}
                </FieldDescription>
              )}
              <FieldError id="partner-user-account-error">
                {errors.account ? t(errors.account) : null}
              </FieldError>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="partner-user-language">{t('staff.form.language')}</FieldLabel>
                <select
                  id="partner-user-language"
                  className={SELECT_CLASS}
                  value={values.language}
                  disabled={blocked}
                  onChange={(event) => set('language')(event.target.value)}
                >
                  <option value="">{t('staff.form.languageDefault')}</option>
                  {languages.map((code) => (
                    <option key={code} value={code}>
                      {languageName(code)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field data-invalid={invalid('phone')}>
                <FieldLabel htmlFor="partner-user-phone">{t('staff.form.phone')}</FieldLabel>
                <Input
                  ref={phoneRef}
                  id="partner-user-phone"
                  type="tel"
                  dir="ltr"
                  value={values.phone}
                  onChange={(event) => set('phone')(event.target.value)}
                  disabled={blocked}
                  aria-invalid={invalid('phone')}
                  aria-describedby={errors.phone ? 'partner-user-phone-error' : undefined}
                  autoComplete="off"
                />
                <FieldError id="partner-user-phone-error">
                  {errors.phone ? t(errors.phone) : null}
                </FieldError>
              </Field>
            </div>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('staff.form.cancel')}
            </Button>
            <Button type="submit" disabled={pending || blocked} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('staff.form.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
