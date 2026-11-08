'use client';

import type { OwnerPolicyField } from '@ssdashboard/contracts';
import { Field, FieldLabel } from '@ssdashboard/ui/components/field';
import { Label } from '@ssdashboard/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@ssdashboard/ui/components/radio-group';
import { LockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { choiceLabelKey, choicesOf, fieldLabelKey } from './owner-policy-choices';

/** Props of `OwnerPolicyChoice`. */
interface OwnerPolicyChoiceProps {
  field: OwnerPolicyField;
  /** The radio value selected now (`choiceOf`). */
  value: string;
  onChange: (choice: string) => void;
  /** True when the field cannot change now: it is shown, not editable. */
  locked: boolean;
  /** The id of the dialog's one sentence saying why fields are locked, read with a locked field. */
  lockNoteId: string;
  /** True when the api said this field breaks a rule or is locked: the group is marked invalid. */
  invalid: boolean;
  /** The id of the dialog's refusal text, read with a group marked invalid. */
  errorId: string;
  /** A unique prefix (from `useId`) for the ids of this field's controls. */
  idBase: string;
}

/**
 * One answer of a location owner type policy in the edit dialog (spec 0009, AC-24): the question
 * as the label and its answers as a radio group (two to four of them, keyboard operable with the
 * arrow keys). A locked field is disabled with a lock, described by the dialog's one sentence
 * saying why, so the person sees the value and why it stays; a field the api refused is marked
 * invalid and described by the refusal text.
 */
export function OwnerPolicyChoice({
  field,
  value,
  onChange,
  locked,
  lockNoteId,
  invalid,
  errorId,
  idBase,
}: OwnerPolicyChoiceProps) {
  const { t } = useTranslation();
  const labelId = `${idBase}-${field}-label`;
  const choices = choicesOf(field);
  const describedBy = [invalid ? errorId : null, locked ? lockNoteId : null]
    .filter((id) => id !== null)
    .join(' ');

  return (
    <Field data-invalid={invalid} data-disabled={locked}>
      <FieldLabel id={labelId} className="flex items-center gap-1.5">
        {t(fieldLabelKey(field))}
        {locked && (
          <>
            <LockIcon aria-hidden className="size-3.5 text-muted-foreground" />
            <span className="sr-only">{t('settings.ownerPolicies.locked')}</span>
          </>
        )}
      </FieldLabel>
      <RadioGroup
        aria-labelledby={labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-invalid={invalid}
        disabled={locked}
        value={value}
        onValueChange={onChange}
        className={choices.length > 2 ? 'grid gap-2' : 'flex flex-wrap gap-x-6 gap-y-2'}
      >
        {choices.map((choice) => (
          <div key={choice} className="flex items-center gap-2">
            <RadioGroupItem id={`${idBase}-${field}-${choice}`} value={choice} />
            <Label htmlFor={`${idBase}-${field}-${choice}`}>
              {t(choiceLabelKey(field, choice))}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </Field>
  );
}
