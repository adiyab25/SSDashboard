'use client';

import type { SettingEntryView } from '@ssdashboard/contracts';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { moduleKeys } from '@/shell/module-states-api';
import { useReturnFocus } from '@/shared/use-return-focus';
import { ModuleOffImpact } from './module-off-impact';
import { getOffImpact, putSetting, settingsKeys } from './settings-api';
import { namesSetting } from './setting-value';
import { useModuleLabel } from './use-module-label';

/** The longest reason the api accepts. */
const REASON_MAX = 500;

/** The api codes the dialog has a sentence for, besides the ones it words itself. */
const SENTENCES = {
  STALE_SETTING: 'settings.dialog.errors.STALE_SETTING',
  SETTING_LOCKED: 'settings.dialog.errors.SETTING_LOCKED',
  NOT_LICENSED: 'settings.dialog.errors.NOT_LICENSED',
  SETTING_UNKNOWN: 'settings.dialog.errors.SETTING_UNKNOWN',
  FORBIDDEN: 'settings.dialog.errors.FORBIDDEN',
} as const satisfies Record<string, MessageKey>;

/** Why the last save failed, in the words the dialog shows. */
type Failure =
  | { kind: 'sentence'; code: keyof typeof SENTENCES | 'generic' }
  | { kind: 'requiredBy'; dependants: string[] };

/**
 * The dialog that turns a module off (spec 0009, AC-12, AC-30): first what will happen (the
 * waiting commands that fail, the work in flight that can still finish, the pieces each partner
 * holds, from `GET /api/settings/:key/off-impact`), then typed confirmation when the api says so,
 * then the reason, which is required. `MODULE_REQUIRED_BY` names the modules that need this one
 * by their labels. The save stays unavailable until the impact has loaded, so nobody confirms
 * blind. It decides nothing: the api refuses what may not be done. Turning a module on is the
 * plain change dialog. Turning an executing step off uses this dialog too (AC-21, AC-30); turning
 * one on is `StepOnDialog`.
 */
export function ModuleOffDialog({
  entry,
  onClose,
  confirmHintKey = 'settings.modules.off.confirmHint',
}: {
  entry: SettingEntryView;
  onClose: () => void;
  /** The hint under the typed confirmation: an executing step names itself as an automation. */
  confirmHintKey?: MessageKey;
}) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const moduleLabel = useModuleLabel();
  const name = t(entry.label as MessageKey);
  const base = useId();
  const confirmId = `${base}-confirm`;
  const reasonId = `${base}-reason`;

  const impactQuery = useQuery({
    queryKey: settingsKeys.offImpact(entry.key),
    queryFn: ({ signal }) => getOffImpact(entry.key, signal),
    // The impact is a fact of this moment: never reuse an earlier one.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const impact = impactQuery.data;
  const typed = impact?.typedConfirmation === true;

  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: () =>
      putSetting(entry.key, {
        value: false,
        reason: reason.trim(),
        expectedUpdatedAt: entry.updatedAt,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
        queryClient.invalidateQueries({ queryKey: moduleKeys.all }),
      ]);
      toast.success(t('settings.modules.off.done', { name }));
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
      } else if (code === 'MODULE_REQUIRED_BY' && error instanceof ApiError) {
        setFailure({ kind: 'requiredBy', dependants: error.body.dependants ?? [] });
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
    if (mutation.isPending || !impact) return;
    const next: typeof errors = {};
    if (typed && !namesSetting(confirmText, name)) {
      next.confirm = t('settings.dialog.errors.confirmMismatch');
    }
    if (reason.trim() === '') next.reason = t('settings.dialog.errors.reasonRequired');
    else if (reason.trim().length > REASON_MAX) {
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

  let failureText: string | null = null;
  if (failure?.kind === 'requiredBy') {
    failureText = t('settings.modules.off.requiredBy', {
      names: failure.dependants.map(moduleLabel).join(t('shell.modules.listSeparator')),
    });
  } else if (failure?.kind === 'sentence') {
    failureText = t(
      failure.code === 'generic' ? 'settings.dialog.errors.generic' : SENTENCES[failure.code],
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('settings.dialog.close')}
        onCloseAutoFocus={returnFocus}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      >
        <form noValidate className="grid gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('settings.modules.off.title', { name })}</DialogTitle>
            <DialogDescription>{t('settings.modules.off.description')}</DialogDescription>
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

          <ModuleOffImpact
            impact={impact}
            loading={impactQuery.isPending}
            failed={impactQuery.isError}
            unavailable={
              impactQuery.error instanceof ApiError &&
              impactQuery.error.code === 'OFF_IMPACT_UNAVAILABLE'
            }
            retrying={impactQuery.isFetching}
            onRetry={() => void impactQuery.refetch()}
          />

          {typed && (
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
                <FieldDescription id={`${confirmId}-hint`}>{t(confirmHintKey)}</FieldDescription>
              )}
            </Field>
          )}

          <Field data-invalid={!!errors.reason}>
            <FieldLabel htmlFor={reasonId}>
              {t('settings.dialog.reason')}
              <span className="font-normal text-muted-foreground">
                ({t('settings.dialog.required')})
              </span>
            </FieldLabel>
            <Textarea
              id={reasonId}
              ref={reasonRef}
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              aria-required
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
            <Button
              type="submit"
              variant="destructive"
              disabled={!impact || impactQuery.isError || mutation.isPending}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('settings.modules.off.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
