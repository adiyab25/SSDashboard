'use client';

import { Field, FieldDescription, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

/**
 * The required written reason of the online actions (spec 0011 AC-11, AC-19): a labelled textarea
 * with the helper text "Describe the stock, not a person" and an error line when it is blank. It
 * only draws the field; the form that owns it validates and sends the reason, and it must never
 * invite a customer name or phone number.
 */
export function OnlineReasonField({
  id,
  invalid,
  register,
}: {
  id: string;
  invalid: boolean;
  register: UseFormRegisterReturn;
}) {
  const { t } = useTranslation();
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>
        {t('inventory.onlineGate.reason')}
        <span className="font-normal text-muted-foreground">({t('inventory.required')})</span>
      </FieldLabel>
      <Textarea
        id={id}
        rows={3}
        maxLength={500}
        aria-required
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : `${id}-hint`}
        {...register}
      />
      {invalid ? (
        <FieldError id={`${id}-error`}>{t('inventory.onlineGate.reasonRequired')}</FieldError>
      ) : (
        <FieldDescription id={`${id}-hint`}>
          {t('inventory.onlineGate.reasonHint')}
        </FieldDescription>
      )}
    </Field>
  );
}
