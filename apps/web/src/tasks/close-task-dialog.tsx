'use client';

import { CloseTaskBody, TASK_NOTE_MAX, taskTypeOf, type TaskListRow } from '@ssdashboard/contracts';
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
import { Label } from '@ssdashboard/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@ssdashboard/ui/components/radio-group';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useReturnFocus } from '@/shared/use-return-focus';
import { closeTaskErrorKey, isTaskOutOfDate } from './close-task-errors';
import { closeTask, taskKeys } from './tasks-api';

/**
 * The close dialog of My work (spec 0016, AC-3, AC-14): the outcomes the api lists as
 * `allowedOutcomes` (the registry's labels, never a code), an optional note (required for the
 * outcomes the registry marks), and the `updatedAt` the row showed sent back as
 * `expectedUpdatedAt`. Each api error code reads as a plain sentence; a task that changed, closed,
 * or vanished refreshes the list and says so, and the dialog then only offers the way back. The
 * note is personal data: it is sent to the api and never logged, stored, or echoed. Focus returns
 * to the Close button, or to the list when the row is gone (`onRestoreFocus`). It never decides
 * who may close: the api does.
 */
export function CloseTaskDialog({
  task: opened,
  onDismiss,
  onRestoreFocus,
}: {
  /** The row as the list showed it when the person opened the dialog; later changes to it are ignored. */
  task: TaskListRow;
  /** The person closed the dialog, or the task was closed and the dialog is done. */
  onDismiss: () => void;
  /** Puts focus on a control that still exists, when the one that opened the dialog is gone. */
  onRestoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const returnFocus = useReturnFocus();
  // The dialog keeps the row it opened on, so a refetch behind it cannot give a fresh token.
  const [task] = useState(opened);
  const definition = taskTypeOf(task.type);
  const typeLabel = definition ? t(definition.label) : t('tasks.row.unknownType');
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [outcomeMissing, setOutcomeMissing] = useState(false);
  const firstOutcome = useRef<HTMLButtonElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const dismissButton = useRef<HTMLButtonElement>(null);

  const noteRequired = definition?.noteRequiredOutcomes?.includes(outcome) ?? false;
  const outcomeLabel = (code: string): string => {
    const key = definition?.outcomeLabels[code];
    return key ? t(key) : code;
  };

  const mutation = useMutation({
    mutationFn: () => {
      const text = note.trim();
      return closeTask(
        task.id,
        CloseTaskBody.parse({
          outcome,
          ...(text !== '' && { note: text }),
          expectedUpdatedAt: task.updatedAt,
        }),
      );
    },
    onSuccess: async () => {
      toast.success(t('tasks.close.done'));
      onDismiss();
      await refetchAfterWrite(queryClient, { queryKey: taskKeys.all });
    },
    onError: async (error) => {
      if (isTaskOutOfDate(error)) {
        await refetchAfterWrite(queryClient, { queryKey: taskKeys.all });
      } else if (error instanceof ApiError && error.code === 'NOTE_REQUIRED') {
        noteField.current?.focus();
      } else if (
        error instanceof ApiError &&
        ['OUTCOME_INVALID', 'OUTCOME_NOT_FOR_PERSON'].includes(error.code)
      ) {
        firstOutcome.current?.focus();
      }
    },
  });

  const failed = mutation.error;
  const outOfDate = isTaskOutOfDate(failed);
  // The form below the alert goes away: put focus on the way back, so a keyboard person lands somewhere.
  useEffect(() => {
    if (outOfDate) dismissButton.current?.focus();
  }, [outOfDate]);
  const alertKey: MessageKey | null = failed ? closeTaskErrorKey(failed) : null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (outcome === '') {
      setOutcomeMissing(true);
      firstOutcome.current?.focus();
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onDismiss()}>
      <DialogContent
        closeLabel={t('tasks.close.closeLabel')}
        onCloseAutoFocus={(event) => {
          returnFocus(event);
          if (!event.defaultPrevented) {
            event.preventDefault();
            onRestoreFocus();
          }
        }}
        className="sm:max-w-lg"
      >
        <form noValidate className="grid gap-6" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{t('tasks.close.title')}</DialogTitle>
            <DialogDescription>
              {typeLabel}. {t('tasks.close.description')}
            </DialogDescription>
          </DialogHeader>

          {alertKey && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(alertKey)}</AlertDescription>
            </Alert>
          )}

          <fieldset className="flex flex-col gap-2" disabled={outOfDate}>
            <legend className="mb-1 text-sm font-medium">{t('tasks.close.outcome')}</legend>
            <RadioGroup
              value={outcome}
              onValueChange={(value) => {
                setOutcome(value);
                setOutcomeMissing(false);
              }}
              aria-required
              aria-invalid={outcomeMissing || undefined}
              aria-describedby={outcomeMissing ? 'close-task-outcome-error' : undefined}
              className="gap-1"
            >
              {task.allowedOutcomes.map((code, index) => (
                <div key={code} className="flex min-h-6 items-center gap-2">
                  <RadioGroupItem
                    ref={index === 0 ? firstOutcome : undefined}
                    value={code}
                    id={`close-task-outcome-${code}`}
                  />
                  <Label htmlFor={`close-task-outcome-${code}`}>{outcomeLabel(code)}</Label>
                </div>
              ))}
            </RadioGroup>
            <FieldError id="close-task-outcome-error">
              {outcomeMissing ? t('tasks.close.outcomeRequired') : null}
            </FieldError>
          </fieldset>

          <Field>
            <FieldLabel htmlFor="close-task-note">
              {t('tasks.close.note')}
              <span className="font-normal text-muted-foreground">
                {noteRequired ? t('tasks.close.noteRequiredMark') : t('tasks.close.noteOptional')}
              </span>
            </FieldLabel>
            <Textarea
              ref={noteField}
              id="close-task-note"
              dir="auto"
              rows={3}
              value={note}
              maxLength={TASK_NOTE_MAX}
              disabled={outOfDate}
              aria-required={noteRequired || undefined}
              aria-describedby="close-task-note-hint"
              onChange={(event) => setNote(event.target.value)}
            />
            <FieldDescription id="close-task-note-hint">
              {t('tasks.close.noteHint')}
            </FieldDescription>
          </Field>

          <DialogFooter>
            <Button
              ref={dismissButton}
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={onDismiss}
            >
              {outOfDate ? t('tasks.close.dismiss') : t('tasks.close.cancel')}
            </Button>
            {!outOfDate && (
              <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
                {mutation.isPending && (
                  <LoaderCircleIcon
                    aria-hidden
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                  />
                )}
                {t('tasks.close.confirm')}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
