'use client';

import {
  CreateStaffRequest,
  type CreateStaffResponse,
  type StaffDetail,
  type StaffHat,
} from '@ssdashboard/contracts';
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
import { CORE_LANGUAGES, isCoreLanguage } from '@ssdashboard/i18n';
import type { MessageKey } from '@ssdashboard/i18n';
import { SELECT_CLASS } from '@/shared/select-class';
import { startingCostView } from './cost-prefill';
import { HatsFieldset } from './hats-fieldset';
import { createStaff, getStaff, updateStaff } from './staff-api';

type FieldName = 'name' | 'email' | 'hats' | 'phone' | 'staffCode';

/** The order problems are focused in: the order the fields are drawn. */
const FIELD_ORDER = ['name', 'email', 'hats', 'phone', 'staffCode'] as const;

/** Create refusals about hats or cost, said in the hats dialog's words. */
const ACCESS_ERRORS = new Set(['FORBIDDEN', 'HAT_CONFLICT', 'GRANT_NOT_ALLOWED']);

interface Values {
  name: string;
  email: string;
  phone: string;
  staffCode: string;
  language: string;
}

const EMPTY: Values = {
  name: '',
  email: '',
  phone: '',
  staffCode: '',
  language: '',
};

interface Props {
  /** The person to edit, or null to add one. */
  editId: string | null;
  /** Language codes enabled on the install (`GET /api/config`). */
  languages: readonly string[];
  /**
   * True when the signed in person holds `cost.view`. Without it the cost switch of a new person
   * stays off and disabled (spec 0008, AC-7 amendment: the api answers 403 otherwise).
   */
  canChangeCost: boolean;
  /**
   * Called after a save. A new account also hands back how the person gets their password.
   * `emailChanged` is true when the email of an invited account was changed by this save.
   */
  onSaved: (result: {
    staff: StaffDetail;
    created?: CreateStaffResponse['setup'];
    emailChanged?: boolean;
  }) => void;
  onClose: () => void;
}

const languageName = (code: string): string =>
  isCoreLanguage(code) ? CORE_LANGUAGES[code].nativeName : code;

/**
 * Add or edit one person (spec 0005, AC-12, AC-15). The email is locked once they have signed in.
 * Adding also picks the person's hats and cost switch (spec 0008, AC-7, AC-14), the switch
 * prefilled from `COST_VIEW_DEFAULT` until moved by hand. Editing changes details only: hats and
 * cost change in the edit hats dialog, and no `role` is ever sent.
 */
export function StaffFormDialog({ editId, languages, canChangeCost, onSaved, onClose }: Props) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Values>(EMPTY);
  const [hats, setHats] = useState<StaffHat[]>([]);
  const [costByHand, setCostByHand] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const staffCodeRef = useRef<HTMLInputElement>(null);
  const firstHatRef = useRef<HTMLInputElement>(null);

  function focusField(name: FieldName) {
    const target = {
      name: nameRef,
      email: emailRef,
      hats: firstHatRef,
      phone: phoneRef,
      staffCode: staffCodeRef,
    }[name];
    target.current?.focus();
  }

  const creating = editId === null;
  const costView =
    costByHand ??
    startingCostView({ hats, storedHats: [], storedCostView: false, canChange: canChangeCost });

  // Editing needs the fields the list does not carry (phone, staff code, language).
  useEffect(() => {
    if (editId === null) return;
    let active = true;
    void getStaff(editId).then((result) => {
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
        staffCode: result.data.staffCode ?? '',
        language: result.data.language ?? '',
      });
    });
    return () => {
      active = false;
    };
  }, [editId, reloads]);

  const loading = editId !== null && detail === null && !loadFailed;
  // A failed load leaves the fields empty: they stay shut, so Save can never clear a phone.
  const blocked = loading || loadFailed;
  // Only a person who sees cost can change the email of someone who sees cost (the api answers 403).
  const costHolderLocked = detail !== null && detail.costView && !canChangeCost;
  const signedInLocked = detail !== null && detail.status !== 'invited';
  const emailLocked = signedInLocked || costHolderLocked;
  const set = (name: keyof Values) => (value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  function validate(): Partial<Record<FieldName, MessageKey>> {
    const parsed = CreateStaffRequest.safeParse({
      name: values.name,
      email: values.email,
      hats,
      costView,
      ...(values.phone.trim() && { phone: values.phone }),
      ...(values.staffCode.trim() && { staffCode: values.staffCode }),
    });
    const found: Partial<Record<FieldName, MessageKey>> = {};
    if (creating && hats.length === 0) found.hats = 'staff.hats.errors.NO_HAT';
    if (parsed.success) return found;
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === 'name') found.name ??= 'staff.form.nameRequired';
      else if (field === 'email') {
        found.email ??= values.email.trim()
          ? 'staff.form.emailInvalid'
          : 'staff.form.emailRequired';
      } else if (field === 'phone') found.phone ??= 'staff.form.phoneInvalid';
      else if (field === 'staffCode') found.staffCode ??= 'staff.form.staffCodeInvalid';
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
    // A new account only sends what was filled in (empty text would be refused); an edit sends
    // empty text to clear a field, and never hats, cost or a role.
    const result =
      editId === null
        ? await createStaff({
            name: values.name,
            email: values.email,
            hats,
            costView,
            ...(values.phone.trim() && { phone: values.phone }),
            ...(values.staffCode.trim() && { staffCode: values.staffCode }),
            ...(values.language.trim() && { language: values.language }),
          })
        : await updateStaff(editId, {
            name: values.name,
            phone: values.phone,
            staffCode: values.staffCode,
            language: values.language,
            ...(!emailLocked && { email: values.email }),
          });
    if (result.ok) {
      const emailChanged =
        editId !== null &&
        detail?.status === 'invited' &&
        values.email.trim().toLowerCase() !== detail.email.trim().toLowerCase();
      onSaved(
        'staff' in result.data
          ? { staff: result.data.staff, created: result.data.setup }
          : { staff: result.data, ...(emailChanged && { emailChanged }) },
      );
      return;
    }
    setPending(false);
    if (result.code === 'EMAIL_TAKEN') {
      setErrors({ email: 'staff.errors.EMAIL_TAKEN' });
      focusField('email');
    } else if (result.code === 'STAFF_CODE_TAKEN') {
      setErrors({ staffCode: 'staff.errors.STAFF_CODE_TAKEN' });
      focusField('staffCode');
    } else if (result.code === 'NO_HAT') {
      setErrors({ hats: 'staff.hats.errors.NO_HAT' });
      focusField('hats');
    } else if (ACCESS_ERRORS.has(result.code)) {
      setFailure(t(`staff.hats.errors.${result.code}` as MessageKey));
    } else {
      const known = `staff.errors.${result.code}` as MessageKey;
      setFailure(t(known, { defaultValue: t('staff.errors.generic') }));
    }
  }

  const field = (name: FieldName) => (errors[name] ? true : undefined);

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
              {editId === null ? t('staff.form.createTitle') : t('staff.form.editTitle')}
            </DialogTitle>
            <DialogDescription>{t('staff.form.description')}</DialogDescription>
          </DialogHeader>

          {(failure || loadFailed) && (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {failure ?? t('staff.form.loadError')}
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
                    {t('staff.form.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <Field data-invalid={field('name')}>
              <FieldLabel htmlFor="staff-name">
                {t('staff.form.name')}
                <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
              </FieldLabel>
              <Input
                ref={nameRef}
                id="staff-name"
                value={values.name}
                onChange={(event) => set('name')(event.target.value)}
                disabled={blocked}
                required
                aria-required
                aria-invalid={field('name')}
                aria-describedby={errors.name ? 'staff-name-error' : undefined}
                autoComplete="off"
              />
              <FieldError id="staff-name-error">{errors.name ? t(errors.name) : null}</FieldError>
            </Field>

            <Field data-invalid={field('email')}>
              <FieldLabel htmlFor="staff-email">
                {t('staff.form.email')}
                <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
              </FieldLabel>
              <Input
                ref={emailRef}
                id="staff-email"
                type="email"
                inputMode="email"
                dir="ltr"
                value={values.email}
                onChange={(event) => set('email')(event.target.value)}
                disabled={blocked || emailLocked}
                required
                aria-required
                aria-invalid={field('email')}
                aria-describedby={
                  errors.email ? 'staff-email-error' : emailLocked ? 'staff-email-help' : undefined
                }
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="off"
              />
              {emailLocked && (
                <FieldDescription id="staff-email-help">
                  {t(signedInLocked ? 'staff.form.emailLocked' : 'staff.form.emailCostHolder')}
                </FieldDescription>
              )}
              <FieldError id="staff-email-error">
                {errors.email ? t(errors.email) : null}
              </FieldError>
            </Field>

            {creating && (
              <HatsFieldset
                idPrefix="staff"
                hats={hats}
                onHatsChange={(next) => {
                  setHats(next);
                  if (next.length > 0) setErrors((current) => ({ ...current, hats: undefined }));
                }}
                costView={costView}
                onCostViewChange={setCostByHand}
                canChangeCost={canChangeCost}
                error={errors.hats ? t(errors.hats) : null}
                firstHatRef={firstHatRef}
              />
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="staff-language">{t('staff.form.language')}</FieldLabel>
                <select
                  id="staff-language"
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
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={field('phone')}>
                <FieldLabel htmlFor="staff-phone">{t('staff.form.phone')}</FieldLabel>
                <Input
                  ref={phoneRef}
                  id="staff-phone"
                  type="tel"
                  dir="ltr"
                  value={values.phone}
                  onChange={(event) => set('phone')(event.target.value)}
                  disabled={blocked}
                  aria-invalid={field('phone')}
                  aria-describedby={errors.phone ? 'staff-phone-error' : undefined}
                  autoComplete="off"
                />
                <FieldError id="staff-phone-error">
                  {errors.phone ? t(errors.phone) : null}
                </FieldError>
              </Field>
              <Field data-invalid={field('staffCode')}>
                <FieldLabel htmlFor="staff-code">{t('staff.form.staffCode')}</FieldLabel>
                <Input
                  ref={staffCodeRef}
                  id="staff-code"
                  dir="ltr"
                  value={values.staffCode}
                  onChange={(event) => set('staffCode')(event.target.value)}
                  disabled={blocked}
                  aria-invalid={field('staffCode')}
                  aria-describedby={errors.staffCode ? 'staff-code-error' : undefined}
                  autoComplete="off"
                />
                <FieldError id="staff-code-error">
                  {errors.staffCode ? t(errors.staffCode) : null}
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
