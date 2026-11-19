'use client';

import type { ModuleStateView, SettingEntryView } from '@ssdashboard/contracts';
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
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellIcon, BellOffIcon, HistoryIcon, InfoIcon, LoaderCircleIcon } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { REASON_KEYS } from '@/shell/module-reason-text';
import { moduleKeys } from '@/shell/module-states-api';
import { useReturnFocus } from '@/shared/use-return-focus';
import { putSetting, settingsKeys } from './settings-api';
import { namesSetting } from './setting-value';
import { useCustomerWords } from './use-customer-words';
import { usePreconditionText } from './use-precondition-text';

/** The longest reason the api accepts. */
const REASON_MAX = 500;

/** The api codes the dialog has a fixed sentence for. */
const SENTENCES = {
  STALE_SETTING: 'settings.dialog.errors.STALE_SETTING',
  SETTING_LOCKED: 'settings.dialog.errors.SETTING_LOCKED',
  NOT_LICENSED: 'settings.dialog.errors.NOT_LICENSED',
  SETTING_UNKNOWN: 'settings.dialog.errors.SETTING_UNKNOWN',
  FORBIDDEN: 'settings.dialog.errors.FORBIDDEN',
  generic: 'settings.automations.turnOn.failed',
} as const satisfies Record<string, MessageKey>;

/** Why the last save failed, in the words the dialog shows. */
type Failure =
  { kind: 'sentence'; code: keyof typeof SENTENCES } | { kind: 'precondition'; code: string };

/**
 * The dialog that switches an executing step on (spec 0009, AC-21, AC-25): in plain words what the
 * app will start doing for the brand, whether the customer hears about it, that it acts only on
 * what happens from now on, the facts its preconditions handed over (such as confirmed counts),
 * the entry's warning, typed confirmation where the registry asks for it, and the reason. A 409
 * `STEP_PRECONDITION` is worded from its code, and the list and module states are read again.
 * When the capability is stopped for another reason it says the step waits until that work runs
 * (AC-21, S1). It decides nothing: the api checks the license and every precondition again.
 * Switching a step off is the off dialog (`ModuleOffDialog`).
 */
export function StepOnDialog({
  entry,
  capability = null,
  onClose,
}: {
  entry: SettingEntryView;
  /** The state of the capability the step gates, or null while it is not known. */
  capability?: ModuleStateView | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const words = usePreconditionText();
  const customerWords = useCustomerWords();
  const name = t(entry.label as MessageKey);
  const step = entry.step ?? null;
  const facts = step?.turnOn.ready ? step.turnOn.facts : [];
  const reasonRequired = entry.reason === 'required';
  const base = useId();
  const confirmId = `${base}-confirm`;
  const reasonId = `${base}-reason`;

  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: () =>
      putSetting(entry.key, {
        value: true,
        ...(reason.trim() !== '' && { reason: reason.trim() }),
        expectedUpdatedAt: entry.updatedAt,
      }),
    onSuccess: async (answer) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
        queryClient.invalidateQueries({ queryKey: moduleKeys.all }),
      ]);
      toast.success(
        answer.changed
          ? t('settings.automations.turnOn.done', { name })
          : t('settings.messages.unchanged'),
      );
      onClose();
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : 'generic';
      if (code === 'REASON_REQUIRED' || code === 'REASON_TOO_LONG') {
        setErrors({
          reason: t(
            code === 'REASON_REQUIRED'
              ? 'settings.dialog.errors.reasonRequired'
              : 'settings.dialog.errors.reasonTooLong',
          ),
        });
        setFailure(null);
        reasonRef.current?.focus();
      } else if (code === 'STEP_PRECONDITION' && error instanceof ApiError) {
        setFailure({ kind: 'precondition', code: error.body.precondition ?? 'UNKNOWN' });
        // The list's turn on check and the module states were stale: read both again.
        void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
        void queryClient.invalidateQueries({ queryKey: moduleKeys.all });
      } else {
        const known = (Object.keys(SENTENCES) as (keyof typeof SENTENCES)[]).find(
          (candidate) => candidate === code,
        );
        setFailure({ kind: 'sentence', code: known ?? 'generic' });
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.isPending) return;
    const next: typeof errors = {};
    if (entry.confirm === 'typed' && !namesSetting(confirmText, name)) {
      next.confirm = t('settings.dialog.errors.confirmMismatch');
    }
    if (reasonRequired && reason.trim() === '') {
      next.reason = t('settings.dialog.errors.reasonRequired');
    } else if (reason.trim().length > REASON_MAX) {
      next.reason = t('settings.dialog.errors.reasonTooLong');
    }
    setErrors(next);
    setFailure(null);
    if (next.confirm || next.reason) {
      // Screen order: the confirmation, then the reason.
      if (next.confirm) confirmRef.current?.focus();
      else reasonRef.current?.focus();
      return;
    }
    mutation.mutate();
  }

  const failureText =
    failure === null
      ? null
      : failure.kind === 'precondition'
        ? words.precondition(failure.code)
        : t(SENTENCES[failure.code]);
  const customer = step === null ? null : customerWords(step);
  // A step may be switched on while its capability is stopped for another reason (AC-21, S1): it
  // then waits until the capability runs again, and the dialog says so.
  const waitsFor =
    capability !== null && (capability.state === 'off' || capability.state === 'read_only')
      ? capability
      : null;

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('settings.dialog.close')}
        onCloseAutoFocus={returnFocus}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      >
        <form noValidate className="grid gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('settings.automations.turnOn.title', { name })}</DialogTitle>
            <DialogDescription>{t('settings.automations.turnOn.description')}</DialogDescription>
          </DialogHeader>

          {failureText && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {failureText}
                {failure?.kind === 'sentence' && failure.code === 'STALE_SETTING' && (
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

          <dl className="grid gap-3 text-sm">
            <div className="grid gap-1">
              <dt className="font-medium">{t('settings.automations.turnOn.startsDoing')}</dt>
              <dd>{t(entry.description as MessageKey)}</dd>
            </div>
            {customer && (
              <div className="grid gap-1">
                <dt className="font-medium">{t('settings.automations.turnOn.customer')}</dt>
                <dd className="flex items-center gap-1.5">
                  {step?.notifiesCustomer ? (
                    <BellIcon aria-hidden className="size-3.5 shrink-0" />
                  ) : (
                    <BellOffIcon aria-hidden className="size-3.5 shrink-0" />
                  )}
                  {customer}
                </dd>
              </div>
            )}
            <div className="grid gap-1">
              <dt className="font-medium">{t('settings.automations.turnOn.fromWhen')}</dt>
              <dd className="flex items-center gap-1.5">
                <HistoryIcon aria-hidden className="size-3.5 shrink-0" />
                {t('settings.automations.turnOn.fromNow')}
              </dd>
            </div>
          </dl>

          {waitsFor && (
            <Alert className="text-muted-foreground">
              <InfoIcon aria-hidden />
              <AlertDescription>
                {t('settings.automations.turnOn.notRunnable')}
                {waitsFor.reason && ` ${t(REASON_KEYS[waitsFor.reason])}`}
              </AlertDescription>
            </Alert>
          )}

          {facts.length > 0 && (
            <div className="grid gap-1 text-sm">
              <p className="font-medium">{t('settings.automations.turnOn.factsHeading')}</p>
              <ul className="list-disc ps-5">
                {facts.map((fact) => (
                  <li key={fact.label}>{words.fact(fact)}</li>
                ))}
              </ul>
            </div>
          )}

          {entry.warning && (
            <Alert className="text-muted-foreground">
              <InfoIcon aria-hidden />
              <AlertDescription>{t(entry.warning as MessageKey)}</AlertDescription>
            </Alert>
          )}

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
                  {t('settings.automations.confirmHint')}
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
              {t('settings.automations.turnOn.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
