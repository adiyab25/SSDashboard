'use client';

import type { OwnerPolicyField, OwnerPolicyFields, OwnerPolicyView } from '@ssdashboard/contracts';
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
import { LoaderCircleIcon, LockIcon } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useReturnFocus } from '@/shared/use-return-focus';
import { ownerPolicyKeys, putOwnerPolicy } from './owner-policies-api';
import { OwnerPolicyChoice } from './owner-policy-choice';
import {
  choiceOf,
  fieldLabelKey,
  OWNER_POLICY_FIELD_ORDER,
  policyFieldsOf,
  withChoice,
} from './owner-policy-choices';
import { useOwnerPolicyLockText } from './use-owner-policy-lock-text';

/** The longest reason the api accepts. */
const REASON_MAX = 500;

/** The consistency rules the api names (`OWNER_POLICY_INCONSISTENT`) and the fields each ties. */
const RULE_FIELDS = {
  handover_is_sale_means_customer_stock: ['handoverIsSale', 'stockOwnedByBrand'],
  sale_at_handover_means_handover_is_sale: ['saleRecordedAt', 'handoverIsSale'],
  online_needs_brand_stock: ['canSellOnline', 'stockOwnedByBrand', 'settlementOwnerType'],
  // The owner's ruling: the consignment row's settlement partner is permanent. The code comes
  // from the api; the screen only marks the field it names.
  consignment_settles_with_partner: ['settlementOwnerType'],
} as const satisfies Record<string, readonly OwnerPolicyField[]>;
type KnownRule = keyof typeof RULE_FIELDS;

const isKnownRule = (rule: string): rule is KnownRule => Object.hasOwn(RULE_FIELDS, rule);
const isField = (field: string): field is OwnerPolicyField =>
  (OWNER_POLICY_FIELD_ORDER as readonly string[]).includes(field);

/** The api codes the dialog has a fixed sentence for. */
const SENTENCES = {
  SELLABLE_LOCATIONS_EXIST: 'settings.ownerPolicies.errors.SELLABLE_LOCATIONS_EXIST',
  STALE_SETTING: 'settings.ownerPolicies.errors.STALE_SETTING',
  OWNER_TYPE_UNKNOWN: 'settings.ownerPolicies.errors.OWNER_TYPE_UNKNOWN',
  FORBIDDEN: 'settings.ownerPolicies.errors.FORBIDDEN',
  VALIDATION_FAILED: 'settings.ownerPolicies.errors.generic',
  generic: 'settings.ownerPolicies.errors.generic',
} as const satisfies Record<string, MessageKey>;

/** Why the last save failed, in the words the dialog shows. */
type Failure =
  | { kind: 'sentence'; code: keyof typeof SENTENCES }
  | { kind: 'inconsistent'; rules: string[] }
  | { kind: 'inUse'; fields: OwnerPolicyField[] };

/** Props of `OwnerPolicyDialog`. */
interface OwnerPolicyDialogProps {
  /** The row as the list showed it: its `updatedAt` is sent back as `expectedUpdatedAt`. */
  policy: OwnerPolicyView;
  onClose: () => void;
}

/**
 * The dialog that edits one location owner type's policy (spec 0009, AC-24, AC-25): every answer
 * as a radio group, the locked ones shown disabled under one sentence saying why, the reminder
 * that it applies to every location of the type and only to future questions, and the reason,
 * which is required. Errors show from the stable codes, on the fields they name (`rules`,
 * `fields`). It never judges the row itself: the api's consistency and lock rules decide.
 */
export function OwnerPolicyDialog({ policy, onClose }: OwnerPolicyDialogProps) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const lockText = useOwnerPolicyLockText();
  const name = t(`settings.ownerPolicies.types.${policy.ownerType}`);
  const locked = new Set<OwnerPolicyField>(policy.lockedFields);
  const why = lockText(policy);
  const base = useId();
  const reasonId = `${base}-reason`;
  const lockNoteId = `${base}-locks`;
  const failureId = `${base}-failure`;

  const [fields, setFields] = useState<OwnerPolicyFields>(() => policyFieldsOf(policy));
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const mutation = useMutation({
    mutationFn: () =>
      putOwnerPolicy(policy.ownerType, {
        ...fields,
        reason: reason.trim(),
        expectedUpdatedAt: policy.updatedAt,
      }),
    onSuccess: async (answer) => {
      await queryClient.invalidateQueries({ queryKey: ownerPolicyKeys.all });
      toast.success(
        answer.changed ? t('settings.messages.saved', { name }) : t('settings.messages.unchanged'),
      );
      onClose();
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : 'generic';
      if (code === 'REASON_REQUIRED') {
        setReasonError(t('settings.dialog.errors.reasonRequired'));
        setFailure(null);
        reasonRef.current?.focus();
      } else if (code === 'OWNER_POLICY_INCONSISTENT' && error instanceof ApiError) {
        setFailure({ kind: 'inconsistent', rules: error.body.rules ?? [] });
      } else if (code === 'OWNER_POLICY_IN_USE' && error instanceof ApiError) {
        setFailure({ kind: 'inUse', fields: (error.body.fields ?? []).filter(isField) });
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
    const trimmed = reason.trim();
    const problem =
      trimmed === ''
        ? t('settings.dialog.errors.reasonRequired')
        : trimmed.length > REASON_MAX
          ? t('settings.dialog.errors.reasonTooLong')
          : null;
    setReasonError(problem);
    setFailure(null);
    if (problem) {
      reasonRef.current?.focus();
      return;
    }
    mutation.mutate();
  }

  // The fields the last refusal points at, marked invalid so the person sees where to look.
  const flagged = new Set<OwnerPolicyField>();
  if (failure?.kind === 'inconsistent') {
    for (const rule of failure.rules) {
      if (isKnownRule(rule)) for (const field of RULE_FIELDS[rule]) flagged.add(field);
    }
  } else if (failure?.kind === 'inUse') {
    for (const field of failure.fields) flagged.add(field);
  } else if (failure?.kind === 'sentence' && failure.code === 'SELLABLE_LOCATIONS_EXIST') {
    flagged.add('canSellOnline');
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        closeLabel={t('settings.dialog.close')}
        onCloseAutoFocus={returnFocus}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
      >
        <form noValidate className="grid gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('settings.ownerPolicies.dialog.title', { name })}</DialogTitle>
            <DialogDescription>{t('settings.ownerPolicies.dialog.description')}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert id={failureId} variant="destructive" role="alert">
              <AlertDescription className="grid gap-2">
                {failure.kind === 'inconsistent' && (
                  <>
                    <p>{t('settings.ownerPolicies.errors.OWNER_POLICY_INCONSISTENT')}</p>
                    <ul className="list-disc ps-5">
                      {failure.rules.map((rule) => (
                        <li key={rule}>
                          {isKnownRule(rule)
                            ? t(`settings.ownerPolicies.rules.${rule}`)
                            : t('settings.ownerPolicies.errors.generic')}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {failure.kind === 'inUse' && (
                  <p>
                    {t('settings.ownerPolicies.errors.OWNER_POLICY_IN_USE', {
                      fields: failure.fields
                        .map((field) => t(fieldLabelKey(field)))
                        .join(t('shell.modules.listSeparator')),
                    })}
                  </p>
                )}
                {failure.kind === 'sentence' && (
                  <div className="flex flex-wrap items-center gap-3">
                    {t(SENTENCES[failure.code])}
                    {failure.code === 'STALE_SETTING' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void queryClient.invalidateQueries({ queryKey: ownerPolicyKeys.all });
                          onClose();
                        }}
                      >
                        {t('settings.ownerPolicies.reload')}
                      </Button>
                    )}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {why && (
            <p id={lockNoteId} className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <LockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {why}
            </p>
          )}

          <div className="grid gap-5">
            {OWNER_POLICY_FIELD_ORDER.map((field) => (
              <OwnerPolicyChoice
                key={field}
                field={field}
                value={choiceOf(fields, field)}
                onChange={(choice) => setFields((current) => withChoice(current, field, choice))}
                locked={locked.has(field)}
                lockNoteId={lockNoteId}
                errorId={failureId}
                invalid={flagged.has(field)}
                idBase={base}
              />
            ))}
          </div>

          <Field data-invalid={!!reasonError}>
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
              aria-invalid={!!reasonError}
              aria-describedby={reasonError ? `${reasonId}-error` : `${reasonId}-hint`}
              onChange={(event) => setReason(event.target.value)}
            />
            {reasonError ? (
              <FieldError id={`${reasonId}-error`}>{reasonError}</FieldError>
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
