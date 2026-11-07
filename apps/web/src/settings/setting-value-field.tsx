'use client';

import { FieldDescription, Field, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { Label } from '@ssdashboard/ui/components/label';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { RadioGroup, RadioGroupItem } from '@ssdashboard/ui/components/radio-group';
import { useTranslation } from 'react-i18next';
import type { SettingDraft, SettingValueKind } from './setting-value';

/** The two answers of a switch, as the catalog's `settings.values` keys. */
const YES_NO = ['yes', 'no'] as const;

/** Props of `SettingValueField`. */
interface SettingValueFieldProps {
  kind: SettingValueKind;
  draft: SettingDraft;
  onDraft: (draft: SettingDraft) => void;
  label: string;
  error: string | undefined;
  /** Faults on single items of a record, by item name (a document prefix, by document type). */
  itemErrors: Record<string, string>;
  fieldRef: { current: HTMLElement | null };
  clearable: boolean;
  /** A unique prefix (from `useId`) for the ids of this field's controls and messages. */
  idBase: string;
}

/**
 * The input for the new value, chosen by the value's type: Yes and No for a switch, a text input
 * for a number (typed in Western or Arabic digits, `inputMode` numeric), a date input, a text
 * input for a code or a list of codes, and one input per prefix for the document prefixes. The
 * first control of the field takes `fieldRef` so an error can focus it. The label says the value
 * is required unless it may be cleared.
 */
export function SettingValueField({
  kind,
  draft,
  onDraft,
  label,
  error,
  itemErrors,
  fieldRef,
  clearable,
  idBase,
}: SettingValueFieldProps) {
  const { t } = useTranslation();
  const errorId = `${idBase}-error`;
  const hintId = `${idBase}-hint`;
  const labelId = `${idBase}-label`;
  const inputId = `${idBase}-input`;
  const describedBy = error ? errorId : kind === 'list' || clearable ? hintId : undefined;
  const hint =
    kind === 'list'
      ? t('settings.dialog.listHint')
      : clearable
        ? t('settings.dialog.clearHint')
        : null;
  const name = (
    <>
      {label}
      {!clearable && (
        <span className="font-normal text-muted-foreground">({t('settings.dialog.required')})</span>
      )}
    </>
  );

  if (kind === 'boolean') {
    return (
      <Field data-invalid={!!error}>
        <FieldLabel id={labelId}>{name}</FieldLabel>
        <RadioGroup
          aria-labelledby={labelId}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={!!error}
          value={draft === true ? 'yes' : 'no'}
          onValueChange={(next) => onDraft(next === 'yes')}
          className="flex gap-6"
        >
          {YES_NO.map((option, index) => (
            <div key={option} className="flex items-center gap-2">
              <RadioGroupItem
                id={`${idBase}-${option}`}
                value={option}
                ref={index === 0 ? (node) => void (fieldRef.current = node) : undefined}
              />
              <Label htmlFor={`${idBase}-${option}`}>{t(`settings.values.${option}`)}</Label>
            </div>
          ))}
        </RadioGroup>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Field>
    );
  }

  if (kind === 'record') {
    const rows = typeof draft === 'object' ? draft : {};
    return (
      <fieldset className="grid gap-3" aria-describedby={error ? errorId : undefined}>
        <legend className="mb-1 flex gap-1 text-sm font-medium">{name}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Object.entries(rows).map(([code, prefix], index) => {
            const itemError = itemErrors[code];
            const itemErrorId = `${idBase}-${code}-error`;
            return (
              <Field key={code} data-invalid={!!error || !!itemError}>
                <FieldLabel htmlFor={`${idBase}-${code}`}>
                  <LtrText>{code}</LtrText>
                </FieldLabel>
                <Input
                  id={`${idBase}-${code}`}
                  ref={index === 0 ? (node) => void (fieldRef.current = node) : undefined}
                  dir="ltr"
                  autoComplete="off"
                  value={prefix}
                  maxLength={8}
                  aria-invalid={!!error || !!itemError}
                  aria-describedby={itemError ? itemErrorId : error ? errorId : undefined}
                  onChange={(event) => onDraft({ ...rows, [code]: event.target.value })}
                />
                {itemError && <FieldError id={itemErrorId}>{itemError}</FieldError>}
              </Field>
            );
          })}
        </div>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </fieldset>
    );
  }

  const numeric = kind === 'number' || kind === 'hour';
  const text = typeof draft === 'string' ? draft : '';
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={inputId}>{name}</FieldLabel>
      <Input
        id={inputId}
        ref={(node) => void (fieldRef.current = node)}
        type={kind === 'date' ? 'date' : 'text'}
        inputMode={numeric ? 'numeric' : undefined}
        dir={kind === 'text' || kind === 'list' ? 'ltr' : undefined}
        autoComplete="off"
        value={text}
        aria-required={!clearable}
        aria-invalid={!!error}
        aria-describedby={describedBy}
        onChange={(event) => onDraft(event.target.value)}
      />
      {error ? (
        <FieldError id={errorId}>{error}</FieldError>
      ) : (
        hint && <FieldDescription id={hintId}>{hint}</FieldDescription>
      )}
    </Field>
  );
}
