'use client';

import type { SettingEntryView, SettingJson } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useReturnFocus } from '@/inventory/use-return-focus';
import { SettingValueField } from './setting-value-field';
import { putSetting, settingsKeys } from './settings-api';
import { useSettingWords } from './use-setting-words';
import {
  displayValue,
  draftOf,
  isCodeKind,
  namesSetting,
  parseDraft,
  valueKindOf,
  type SettingDraft,
} from './setting-value';

/** The longest reason the api accepts. */
const REASON_MAX = 500;

/** The api error codes the dialog has a sentence for; anything else is the generic one. */
const KNOWN_ERRORS = [
  'SETTING_INVALID',
  'VALIDATION_FAILED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'STALE_SETTING',
  'SETTING_LOCKED',
  'SETTING_UNKNOWN',
  'SETTING_UNREADABLE',
  'FORBIDDEN',
] as const;
type KnownError = (typeof KNOWN_ERRORS)[number];

/** The catalog key of the sentence each api code shows; two codes share a sentence. */
const ERROR_KEYS = {
  SETTING_INVALID: 'settings.dialog.errors.SETTING_INVALID',
  VALIDATION_FAILED: 'settings.dialog.errors.SETTING_INVALID',
  REASON_REQUIRED: 'settings.dialog.errors.reasonRequired',
  REASON_TOO_LONG: 'settings.dialog.errors.reasonTooLong',
  STALE_SETTING: 'settings.dialog.errors.STALE_SETTING',
  SETTING_LOCKED: 'settings.dialog.errors.SETTING_LOCKED',
  SETTING_UNKNOWN: 'settings.dialog.errors.SETTING_UNKNOWN',
  SETTING_UNREADABLE: 'settings.dialog.errors.SETTING_UNREADABLE',
  FORBIDDEN: 'settings.dialog.errors.FORBIDDEN',
  generic: 'settings.dialog.errors.generic',
} as const satisfies Record<KnownError | 'generic', MessageKey>;

const knownError = (code: string): KnownError | 'generic' =>
  KNOWN_ERRORS.find((known) => known === code) ?? 'generic';

/** Props of `SettingChangeDialog`. */
interface SettingChangeDialogProps {
  /** The entry as the list showed it: its `updatedAt` is sent back as `expectedUpdatedAt`. */
  entry: SettingEntryView;
  onClose: () => void;
}

/**
 * The dialog that changes one setting (spec 0009, AC-25): the new value in an input that fits
 * its type, the entry's warning, a typed confirmation where the registry asks for one, and a
 * reason (required where the registry says so). Errors from the api show on the field they
 * belong to, from the stable code; a stale answer offers a reload. It never validates the value
 * itself: the api's schema decides.
 */
export function SettingChangeDialog({ entry, onClose }: SettingChangeDialogProps) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const kind = valueKindOf(entry);
  const words = useSettingWords();
  const name = t(entry.label as MessageKey);
  const reasonRequired = entry.reason === 'required';
  const base = useId();
  const valueBase = `${base}-value`;
  const confirmId = `${base}-confirm`;
  const reasonId = `${base}-reason`;

  const [draft, setDraft] = useState<SettingDraft>(() => draftOf(entry.value, kind));
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [errors, setErrors] = useState<{ value?: string; reason?: string; confirm?: string }>({});
  // Faults the api placed on one item of the value: a document prefix, by its document type.
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<KnownError | 'generic' | null>(null);
  const valueRef = useRef<HTMLElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: (value: SettingJson) =>
      putSetting(entry.key, {
        value,
        ...(reason.trim() !== '' && { reason: reason.trim() }),
        expectedUpdatedAt: entry.updatedAt,
      }),
    onSuccess: async (answer) => {
      await queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      toast.success(
        answer.changed ? t('settings.messages.saved', { name }) : t('settings.messages.unchanged'),
      );
      onClose();
    },
    onError: (error) => {
      const code = error instanceof ApiError ? knownError(error.code) : 'generic';
      if (code === 'SETTING_INVALID' || code === 'VALIDATION_FAILED') {
        const issues = error instanceof ApiError ? (error.body.issues ?? []) : [];
        const items: Record<string, string> = {};
        if (kind === 'record' && typeof draft === 'object') {
          for (const issue of issues) {
            if (Object.hasOwn(draft, issue.path)) {
              items[issue.path] = t('settings.dialog.errors.prefixInvalid');
            }
          }
        }
        // A language issue's path is the index of the code in the list: name that code.
        let message: string = t(ERROR_KEYS[code]);
        if (kind === 'list') {
          const parsed = parseDraft(draft, 'list');
          const codes = parsed.ok && Array.isArray(parsed.value) ? parsed.value : [];
          const badIndex = issues
            .map((issue) => Number(issue.path))
            .find((i) => Number.isInteger(i));
          const bad = badIndex === undefined ? undefined : codes[badIndex];
          if (typeof bad === 'string')
            message = t('settings.dialog.errors.languageInvalid', { code: bad });
        }
        setItemErrors(items);
        // A fault on one prefix shows on that input; anything else shows on the field.
        setErrors(Object.keys(items).length > 0 ? {} : { value: message });
        setFailure(null);
        const first = Object.keys(items)[0];
        if (first !== undefined) document.getElementById(`${valueBase}-${first}`)?.focus();
        else valueRef.current?.focus();
      } else if (code === 'REASON_REQUIRED' || code === 'REASON_TOO_LONG') {
        setErrors({ reason: t(ERROR_KEYS[code]) });
        setFailure(null);
        reasonRef.current?.focus();
      } else {
        setFailure(code);
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.isPending) return;
    const parsed = parseDraft(draft, kind);
    const next: typeof errors = {};
    if (!parsed.ok) next.value = t('settings.dialog.errors.valueRequired');
    if (reasonRequired && reason.trim() === '') {
      next.reason = t('settings.dialog.errors.reasonRequired');
    } else if (reason.trim().length > REASON_MAX) {
      next.reason = t('settings.dialog.errors.reasonTooLong');
    }
    if (entry.confirm === 'typed' && !namesSetting(confirmText, name)) {
      next.confirm = t('settings.dialog.errors.confirmMismatch');
    }
    setErrors(next);
    setItemErrors({});
    setFailure(null);
    if (!parsed.ok || next.reason || next.confirm) {
      // Screen order: the value, the confirmation, then the reason.
      if (next.value) valueRef.current?.focus();
      else if (next.confirm) confirmRef.current?.focus();
      else reasonRef.current?.focus();
      return;
    }
    mutation.mutate(parsed.value);
  }

  const warning = entry.warning ? t(entry.warning as MessageKey) : null;
  const current = displayValue(entry.value, kind, words);
  const monospace = isCodeKind(kind);

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('settings.dialog.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-lg"
      >
        <form noValidate className="grid gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('settings.dialog.title', { name })}</DialogTitle>
            <DialogDescription>{t(entry.description as MessageKey)}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {t(ERROR_KEYS[failure])}
                {failure === 'STALE_SETTING' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
                      onClose();
                    }}
                  >
                    {t('settings.dialog.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {warning && (
            <Alert>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          )}

          <p className="text-sm text-muted-foreground">
            {t('settings.dialog.description')}{' '}
            {monospace && entry.value !== null ? <LtrText>{current}</LtrText> : current}
          </p>

          <SettingValueField
            kind={kind}
            draft={draft}
            onDraft={setDraft}
            label={t('settings.dialog.newValue')}
            error={errors.value}
            itemErrors={itemErrors}
            idBase={valueBase}
            fieldRef={valueRef}
            clearable={entry.default === null}
          />

          {entry.confirm === 'typed' && (
            <Field data-invalid={!!errors.confirm}>
              <FieldLabel htmlFor={confirmId}>
                {t('settings.dialog.confirmLabel', { name })}
              </FieldLabel>
              <Input
                id={confirmId}
                ref={confirmRef}
                autoComplete="off"
                value={confirmText}
                aria-required
                aria-invalid={!!errors.confirm}
                aria-describedby={errors.confirm ? `${confirmId}-error` : `${confirmId}-hint`}
                onChange={(event) => setConfirmText(event.target.value)}
              />
              {errors.confirm ? (
                <FieldError id={`${confirmId}-error`}>{errors.confirm}</FieldError>
              ) : (
                <FieldDescription id={`${confirmId}-hint`}>
                  {t('settings.dialog.confirmHint')}
                </FieldDescription>
              )}
            </Field>
          )}

          <Field data-invalid={!!errors.reason}>
            <FieldLabel htmlFor={reasonId}>
              {t('settings.dialog.reason')}
              <span className="font-normal text-muted-foreground">
                ({reasonRequired ? t('settings.dialog.required') : t('settings.dialog.optional')})
              </span>
            </FieldLabel>
            <Textarea
              id={reasonId}
              ref={reasonRef}
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              aria-required={reasonRequired}
              aria-invalid={!!errors.reason}
              aria-describedby={errors.reason ? `${reasonId}-error` : `${reasonId}-hint`}
              onChange={(event) => setReason(event.target.value)}
            />
            {errors.reason ? (
              <FieldError id={`${reasonId}-error`}>{errors.reason}</FieldError>
            ) : (
              <FieldDescription id={`${reasonId}-hint`}>
                {t('settings.dialog.reasonHint')}
              </FieldDescription>
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t('settings.dialog.cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('settings.dialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
