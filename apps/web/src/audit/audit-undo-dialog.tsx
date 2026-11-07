'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AUDIT_UNDO_REASON_MAX,
  AuditUndoRequest,
  auditActionOf,
  type AuditEntryView,
} from '@ssdashboard/contracts';
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
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useReturnFocus } from '@/shared/use-return-focus';
import { ApiError } from '@/api/client';
import { auditKeys, undoAuditEntry } from './audit-api';
import { useEntryText } from './use-entry-text';

type UndoInput = z.input<typeof AuditUndoRequest>;
type UndoOutput = z.output<typeof AuditUndoRequest>;

const SELECT =
  'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-ring md:text-sm dark:bg-input/30';

/** Codes after which sending the same undo again can never work, so the button stays off. */
const FINAL_CODES = new Set(['ENTRY_NOT_FOUND', 'NOT_UNDOABLE', 'ALREADY_UNDONE', 'FORBIDDEN']);

/** The error codes whose message belongs under the reason field, not in the alert. */
const REASON_CODES = new Set(['REASON_REQUIRED', 'REASON_TOO_LONG', 'REASON_INVALID']);

/**
 * Confirms an undo in one step (spec 0010, AC-14, owner question 3): the typed reason sits in the
 * same dialog as the destructive button, so the person never meets a second confirmation. An
 * action whose record type keeps reason codes (`undoReasonCodes` in the registry) offers a select
 * of those codes instead of free text, because the api refuses anything else. Each api error
 * shows from its stable code; `UNDO_NOT_POSSIBLE` also names the owner's code. On success every
 * query refreshes (`invalidateQueries()` with no key, M4R6: the owning module's screens read the
 * data the handler just changed, and an undo is rare) and `onUndone` runs; after a final refusal
 * (already undone, not undoable, not found) the audit list, detail, and history refresh (M4R5), so
 * the stored state shows behind the dialog. Cancel and Escape give focus
 * back to the Undo button that opened it. Never undoes anything by itself: the api decides.
 */
export function AuditUndoDialog({
  entry,
  onClose,
  onUndone,
  onDoneFocus,
}: {
  /** The entry to undo. */
  entry: AuditEntryView;
  onClose: () => void;
  /** Runs once the api answered 200, with the new undone entry. */
  onUndone: (undone: AuditEntryView) => void;
  /** Moves focus once the dialog has closed after a success (the Undo button is gone by then). */
  onDoneFocus: () => void;
}) {
  const { t, i18n } = useTranslation();
  const text = useEntryText();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const succeeded = useRef(false);
  const codes = auditActionOf(entry.action)?.undoReasonCodes;
  const form = useForm<UndoInput, unknown, UndoOutput>({
    resolver: zodResolver(AuditUndoRequest),
    mode: 'onTouched',
    defaultValues: { reason: '' },
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (values: UndoOutput) => undoAuditEntry(entry.id, values.reason),
    onSuccess: (undone) => {
      succeeded.current = true;
      // Everything: the audit screens (the original now reads `undone`) and the owner's screens.
      void queryClient.invalidateQueries();
      onUndone(undone);
    },
    onError: (error) => {
      if (error instanceof ApiError && REASON_CODES.has(error.code)) {
        form.setFocus('reason');
      }
      // Someone else undid it, or it changed meanwhile: show the stored state behind the dialog.
      if (error instanceof ApiError && FINAL_CODES.has(error.code)) {
        void queryClient.invalidateQueries({
          queryKey: auditKeys.all,
          predicate: (query) => query.queryKey[1] !== 'people',
        });
      }
    },
  });

  const failed = mutation.error instanceof ApiError ? mutation.error : null;
  const failure = mutation.error && !failed ? t('audit.undo.errors.generic') : failureText(failed);
  const reasonFailure = failed && REASON_CODES.has(failed.code) ? failure : null;
  const alertFailure = reasonFailure ? null : failure;

  function failureText(error: ApiError | null): string | null {
    if (!error) return null;
    switch (error.code) {
      case 'ENTRY_NOT_FOUND':
        return t('audit.undo.errors.entryNotFound');
      case 'NOT_UNDOABLE':
        return t('audit.undo.errors.notUndoable');
      case 'ALREADY_UNDONE':
        return t('audit.undo.errors.alreadyUndone');
      case 'UNDO_NOT_POSSIBLE':
        return t('audit.undo.errors.notPossible');
      case 'REASON_REQUIRED':
        return t('audit.undo.errors.reasonRequired');
      case 'REASON_TOO_LONG':
        return t('audit.undo.errors.reasonTooLong', { max: AUDIT_UNDO_REASON_MAX });
      case 'REASON_INVALID':
        return t('audit.undo.errors.reasonInvalid');
      case 'INVALID_INPUT':
        return t('audit.undo.errors.invalidInput');
      case 'FORBIDDEN':
        return t('audit.undo.errors.forbidden');
      default:
        return t('audit.undo.errors.generic');
    }
  }

  /** A reason code's label from the catalog when one is written, else the code itself. */
  function codeLabel(code: string): string {
    const key = `audit.undo.reasonCodes.${code}`;
    return i18n.exists(key) ? t(key as MessageKey) : code;
  }

  const formProblem = errors.reason
    ? errors.reason.type === 'too_big'
      ? t('audit.undo.errors.reasonTooLong', { max: AUDIT_UNDO_REASON_MAX })
      : codes
        ? t('audit.undo.errors.reasonInvalid')
        : t('audit.undo.errors.reasonRequired')
    : null;
  const problem = formProblem ?? reasonFailure;
  const label = codes ? t('audit.undo.reasonCode') : t('audit.undo.reason');

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('audit.detail.close')}
        onCloseAutoFocus={(event) => {
          if (succeeded.current) {
            event.preventDefault();
            onDoneFocus();
          } else {
            returnFocus(event);
          }
        }}
        className="sm:max-w-lg"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => void form.handleSubmit((values) => mutation.mutate(values))(event)}
        >
          <DialogHeader>
            <DialogTitle>{t('audit.undo.title', { action: text.actionName(entry) })}</DialogTitle>
            <DialogDescription>{t('audit.undo.description')}</DialogDescription>
          </DialogHeader>

          {alertFailure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-col gap-1">
                {alertFailure}
                {failed?.code === 'UNDO_NOT_POSSIBLE' && failed.body.undoCode && (
                  <span>
                    {t('audit.undo.errors.notPossibleCode', { code: failed.body.undoCode })}
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}

          <Field data-invalid={!!problem}>
            <FieldLabel htmlFor="undo-reason">
              {label}
              <span className="font-normal text-muted-foreground">
                ({t('audit.undo.required')})
              </span>
            </FieldLabel>
            {codes ? (
              <select
                id="undo-reason"
                className={SELECT}
                aria-required
                aria-invalid={!!problem}
                aria-describedby={problem ? 'undo-reason-error' : undefined}
                {...form.register('reason')}
              >
                <option value="">{t('audit.undo.reasonCodeChoose')}</option>
                {codes.map((code) => (
                  <option key={code} value={code}>
                    {codeLabel(code)}
                  </option>
                ))}
              </select>
            ) : (
              <Textarea
                id="undo-reason"
                rows={3}
                maxLength={AUDIT_UNDO_REASON_MAX}
                aria-required
                aria-invalid={!!problem}
                aria-describedby={problem ? 'undo-reason-error' : 'undo-reason-hint'}
                {...form.register('reason')}
              />
            )}
            {problem ? (
              <FieldError id="undo-reason-error">{problem}</FieldError>
            ) : codes ? null : (
              <FieldDescription id="undo-reason-hint">
                {t('audit.undo.reasonHint')}
              </FieldDescription>
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t('audit.undo.cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={mutation.isPending || (!!failed && FINAL_CODES.has(failed.code))}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('audit.undo.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
