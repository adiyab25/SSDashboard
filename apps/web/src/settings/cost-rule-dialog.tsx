'use client';

import type { OrderCostRuleKind, OrderCostRuleStatus } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Alert, AlertDescription, AlertTitle } from '@ssdashboard/ui/components/alert';
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
import { Label } from '@ssdashboard/ui/components/label';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { RadioGroup, RadioGroupItem } from '@ssdashboard/ui/components/radio-group';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { Fragment, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useReturnFocus } from '@/shared/use-return-focus';
import { checkRuleValue, isPercentKind } from './cost-rule-value';
import { costRuleKeys, recordCostRule } from './cost-rules-api';
import { useCostRuleText } from './use-cost-rule-text';

/** The longest reason the api accepts. */
const REASON_MAX = 500;

/** The two kinds of rule, as the catalog's `settings.costRules.dialog` keys. */
const STATUSES: readonly { status: OrderCostRuleStatus; labelKey: MessageKey }[] = [
  { status: 'set', labelKey: 'settings.costRules.dialog.set' },
  { status: 'not_set', labelKey: 'settings.costRules.dialog.notSet' },
];

/** The api codes shown as a sentence above the form. */
const SENTENCES = {
  LOCK_DATE_UNREADABLE: 'settings.costRules.lockInvalid',
  FORBIDDEN: 'settings.costRules.dialog.errors.FORBIDDEN',
  SETTING_INVALID: 'settings.costRules.dialog.errors.SETTING_INVALID',
  generic: 'settings.costRules.dialog.errors.generic',
} as const satisfies Record<string, MessageKey>;

/** The catalog key of each problem a typed value can have. */
const VALUE_PROBLEMS = {
  required: 'settings.costRules.dialog.errors.valueRequired',
  invalid: 'settings.costRules.dialog.errors.valueInvalid',
  percentTooHigh: 'settings.costRules.dialog.errors.percentTooHigh',
} as const satisfies Record<string, MessageKey>;

/** Props of `CostRuleDialog`. */
interface CostRuleDialogProps {
  kind: OrderCostRuleKind;
  /** The operating day the page read the rules for: the start day the form offers first. */
  today: string;
  onClose: () => void;
}

/**
 * The dialog that records a new per order cost rule (spec 0009, AC-23): set with a value (a percent
 * from 0 to 100, or an amount per order, typed in Western or Arabic digits) or not set, the first
 * operating day it applies to, and the reason, which is required. A start day in a locked period
 * answers 409 `COST_RULE_IN_LOCKED_PERIOD`: the dialog names the months whose margins it would
 * change and offers to record it in the locked period on purpose, with the same reason (D14), so
 * nobody moves the lock date. Rules are never edited; a new one takes over from its day.
 */
export function CostRuleDialog({ kind, today, onClose }: CostRuleDialogProps) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const words = useCostRuleText();
  const name = words.kindName(kind);
  const percent = isPercentKind(kind);
  const base = useId();
  const statusLabelId = `${base}-status`;
  const valueId = `${base}-value`;
  const dateId = `${base}-date`;
  const reasonId = `${base}-reason`;

  const [status, setStatus] = useState<OrderCostRuleStatus>('set');
  const [value, setValue] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ value?: string; date?: string; reason?: string }>({});
  const [failure, setFailure] = useState<keyof typeof SENTENCES | null>(null);
  // 409 COST_RULE_IN_LOCKED_PERIOD: the months it would change; the next save overrides the lock.
  const [lockedMonths, setLockedMonths] = useState<string[] | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const mutation = useMutation({
    mutationFn: (body: { value?: string; inLockedPeriod: boolean }) =>
      recordCostRule({
        kind,
        status,
        ...(body.value !== undefined && { value: body.value }),
        effectiveFrom,
        reason: reason.trim(),
        ...(body.inLockedPeriod && { inLockedPeriod: true }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: costRuleKeys.all });
      toast.success(t('settings.costRules.done', { name }));
      onClose();
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : 'generic';
      if (code === 'COST_RULE_IN_LOCKED_PERIOD' && error instanceof ApiError) {
        setLockedMonths(error.body.months ?? []);
        setFailure(null);
      } else if (code === 'REASON_REQUIRED') {
        setErrors({ reason: t('settings.dialog.errors.reasonRequired') });
        setFailure(null);
        reasonRef.current?.focus();
      } else if (code === 'SETTING_INVALID' || code === 'VALIDATION_FAILED') {
        const issues = error instanceof ApiError ? (error.body.issues ?? []) : [];
        const onValue =
          status === 'set' &&
          (issues.length === 0 || issues.some((issue) => issue.path === 'value'));
        if (onValue) {
          // The value field is on screen: the refusal shows on it.
          setErrors({ value: t('settings.costRules.dialog.errors.SETTING_INVALID') });
          setFailure(null);
          valueRef.current?.focus();
        } else {
          // Not about a field the person can see: the sentence goes above the form.
          setFailure('SETTING_INVALID');
        }
      } else {
        setFailure(code === 'LOCK_DATE_UNREADABLE' || code === 'FORBIDDEN' ? code : 'generic');
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.isPending) return;
    const next: typeof errors = {};
    const checked = status === 'set' ? checkRuleValue(value, kind) : null;
    if (checked && !checked.ok) next.value = t(VALUE_PROBLEMS[checked.problem]);
    if (effectiveFrom.trim() === '') next.date = t('settings.costRules.dialog.errors.dateRequired');
    const trimmed = reason.trim();
    if (trimmed === '') next.reason = t('settings.dialog.errors.reasonRequired');
    else if (trimmed.length > REASON_MAX) next.reason = t('settings.dialog.errors.reasonTooLong');
    setErrors(next);
    setFailure(null);
    if (next.value || next.date || next.reason) {
      // Screen order: the value, the start day, then the reason.
      if (next.value) valueRef.current?.focus();
      else if (next.date) dateRef.current?.focus();
      else reasonRef.current?.focus();
      return;
    }
    mutation.mutate({
      ...(checked?.ok && { value: checked.value }),
      inLockedPeriod: lockedMonths !== null,
    });
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
            <DialogTitle>{t('settings.costRules.dialog.title', { name })}</DialogTitle>
            <DialogDescription>{t('settings.costRules.dialog.description')}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(SENTENCES[failure])}</AlertDescription>
            </Alert>
          )}

          {lockedMonths && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{t('settings.costRules.dialog.lockedTitle')}</AlertTitle>
              <AlertDescription className="grid gap-2">
                <p>
                  {t('settings.costRules.dialog.lockedMonthsIntro')}{' '}
                  {lockedMonths.map((month, index) => (
                    <Fragment key={month}>
                      {index > 0 && t('shell.modules.listSeparator')}
                      <LtrText>{month}</LtrText>
                    </Fragment>
                  ))}
                </p>
                <p>{t('settings.costRules.dialog.lockedOverride')}</p>
              </AlertDescription>
            </Alert>
          )}

          <Field>
            <FieldLabel id={statusLabelId}>{t('settings.costRules.dialog.status')}</FieldLabel>
            <RadioGroup
              aria-labelledby={statusLabelId}
              value={status}
              onValueChange={(next) => {
                setStatus(next === 'not_set' ? 'not_set' : 'set');
                setErrors((current) => ({ ...current, value: undefined }));
              }}
              className="grid gap-2"
            >
              {STATUSES.map((option) => (
                <div key={option.status} className="flex items-center gap-2">
                  <RadioGroupItem id={`${base}-${option.status}`} value={option.status} />
                  <Label htmlFor={`${base}-${option.status}`}>{t(option.labelKey)}</Label>
                </div>
              ))}
            </RadioGroup>
          </Field>

          {status === 'set' && (
            <Field data-invalid={!!errors.value}>
              <FieldLabel htmlFor={valueId}>
                {t(
                  percent
                    ? 'settings.costRules.dialog.percent'
                    : 'settings.costRules.dialog.amount',
                )}
                <span className="font-normal text-muted-foreground">
                  ({t('settings.dialog.required')})
                </span>
              </FieldLabel>
              <Input
                id={valueId}
                ref={valueRef}
                inputMode="decimal"
                autoComplete="off"
                className="tabular-nums"
                value={value}
                aria-required
                aria-invalid={!!errors.value}
                aria-describedby={errors.value ? `${valueId}-error` : `${valueId}-hint`}
                onChange={(event) => setValue(event.target.value)}
              />
              {errors.value ? (
                <FieldError id={`${valueId}-error`}>{errors.value}</FieldError>
              ) : (
                <FieldDescription id={`${valueId}-hint`}>
                  {t(
                    percent
                      ? 'settings.costRules.dialog.percentHint'
                      : 'settings.costRules.dialog.amountHint',
                  )}
                </FieldDescription>
              )}
            </Field>
          )}

          <Field data-invalid={!!errors.date}>
            <FieldLabel htmlFor={dateId}>
              {t('settings.costRules.dialog.effectiveFrom')}
              <span className="font-normal text-muted-foreground">
                ({t('settings.dialog.required')})
              </span>
            </FieldLabel>
            <Input
              id={dateId}
              ref={dateRef}
              type="date"
              value={effectiveFrom}
              aria-required
              aria-invalid={!!errors.date}
              aria-describedby={errors.date ? `${dateId}-error` : `${dateId}-hint`}
              onChange={(event) => {
                setEffectiveFrom(event.target.value);
                // A new day needs its own lock check: the override applies to the day it named.
                setLockedMonths(null);
              }}
            />
            {errors.date ? (
              <FieldError id={`${dateId}-error`}>{errors.date}</FieldError>
            ) : (
              <FieldDescription id={`${dateId}-hint`}>
                {t('settings.costRules.dialog.effectiveFromHint')}
              </FieldDescription>
            )}
          </Field>

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
              variant={lockedMonths ? 'destructive' : 'default'}
              disabled={mutation.isPending}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t(
                lockedMonths
                  ? 'settings.costRules.dialog.overrideSave'
                  : 'settings.costRules.dialog.save',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
