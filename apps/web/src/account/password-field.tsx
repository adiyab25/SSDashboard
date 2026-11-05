'use client';

import { Field, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { useTranslation } from 'react-i18next';

/** Props of `PasswordField`. */
interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  id: string;
}

/** The current password input of the two factor dialogs, with its required marker and error. */
export function PasswordField({ value, onChange, invalid, inputRef, id }: PasswordFieldProps) {
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
