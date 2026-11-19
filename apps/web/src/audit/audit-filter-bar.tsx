'use client';

import { AUDIT_ACTION_CODES, AUDIT_ACTIONS, AUDIT_RECORD_TYPES } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SELECT_CLASS } from '@/shared/select-class';
import { auditKeys, listPeople, type AuditFilter } from './audit-api';
import {
  FILTER_NAMES,
  filterProblems,
  paramsFromFilter,
  type FilterProblems,
} from './audit-filter';
import { useEntryText } from './use-entry-text';

const RECORD_TYPES = Object.keys(AUDIT_RECORD_TYPES) as (keyof typeof AUDIT_RECORD_TYPES)[];

/** The id of the hint under the correlation field, linked by `aria-describedby`. */
const CORRELATION_HINT_ID = 'audit-correlation-hint';

/** The id of each filter's control, so a problem can move focus to it. */
const FIELD_IDS = {
  actorUserId: 'audit-person',
  recordType: 'audit-record-type',
  recordId: 'audit-record-id',
  action: 'audit-action',
  dayFrom: 'audit-day-from',
  dayTo: 'audit-day-to',
  correlationId: 'audit-correlation',
} as const satisfies Record<keyof AuditFilter, string>;

/**
 * The audit filters (spec 0010, AC-12): person (from the staff list), record type and record ID,
 * action (from the registry), a day range, and the ID of one action's entries. Typing changes a
 * draft; Apply checks it and hands it up, so the page can put it in the URL and a link reproduces
 * the view. Clear applies an empty filter. A draft that breaks a rule is not applied: each rule
 * shows under its own field (`aria-invalid`, `aria-describedby`) and focus moves to the first
 * invalid field. Never calls the audit list itself.
 */
export function AuditFilterBar({
  applied,
  onApply,
  peopleEnabled,
}: {
  /** The filter the page is showing, from the URL. */
  applied: AuditFilter;
  onApply: (filter: AuditFilter) => void;
  /**
   * Whether the person picker may read the staff list (`people.manage`, spec 0008); without it
   * the picker offers only Anyone and a person id in the URL still filters.
   */
  peopleEnabled: boolean;
}) {
  const { t } = useTranslation();
  const text = useEntryText();
  const appliedKey = paramsFromFilter(applied);
  const [seen, setSeen] = useState(appliedKey);
  const [draft, setDraft] = useState<AuditFilter>(applied);
  const [pending, setPending] = useState<string | null>(null);
  const [problems, setProblems] = useState<FilterProblems>({});
  const people = useQuery({
    queryKey: auditKeys.people,
    queryFn: listPeople,
    staleTime: 60_000,
    enabled: peopleEnabled,
  });

  // The URL changed under the bar (a "same action" link, Back): show it. A change this bar
  // asked for itself is not shown again, so text typed while the page navigates is kept.
  if (seen !== appliedKey) {
    setSeen(appliedKey);
    if (appliedKey === pending) {
      setPending(null);
    } else {
      setDraft(applied);
      setProblems({});
    }
  }

  const set = (name: keyof AuditFilter) => (value: string) => {
    setDraft((current) => ({ ...current, [name]: value || undefined }));
    setProblems((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = filterProblems(draft);
    setProblems(found);
    const first = FILTER_NAMES.find((name) => found[name]);
    if (first) {
      document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    setPending(paramsFromFilter(draft));
    onApply(draft);
  }

  function clear() {
    setDraft({});
    setProblems({});
    setPending('');
    onApply({});
  }

  /** The invalid state of one control, and the id of its message. */
  function invalid(name: keyof AuditFilter, hint?: string) {
    const id = `${FIELD_IDS[name]}-error`;
    return {
      'aria-invalid': problems[name] ? true : undefined,
      'aria-describedby':
        [problems[name] ? id : undefined, hint].filter(Boolean).join(' ') || undefined,
    };
  }

  /** The message of one field's problem, under the field. */
  function problem(name: keyof AuditFilter) {
    const found = problems[name];
    return found ? (
      <FieldError id={`${FIELD_IDS[name]}-error`}>
        {t(`audit.filters.problems.${found}`)}
      </FieldError>
    ) : null;
  }

  const known = people.data?.people.some((person) => person.id === draft.actorUserId) ?? false;

  return (
    <form noValidate onSubmit={submit} aria-label={t('audit.filters.title')} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field data-invalid={!!problems.actorUserId}>
          <FieldLabel htmlFor={FIELD_IDS.actorUserId}>{t('audit.filters.person')}</FieldLabel>
          <select
            id={FIELD_IDS.actorUserId}
            className={SELECT_CLASS}
            value={draft.actorUserId ?? ''}
            onChange={(event) => set('actorUserId')(event.target.value)}
            {...invalid('actorUserId')}
          >
            <option value="">{t('audit.filters.anyPerson')}</option>
            {draft.actorUserId && !known && (
              <option value={draft.actorUserId}>{draft.actorUserId}</option>
            )}
            {people.data?.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
          {problem('actorUserId')}
          {people.isError && (
            <span className="text-xs text-muted-foreground">
              {t('audit.filters.personLoadError')}
            </span>
          )}
          {people.data?.truncated && (
            <span className="text-xs text-muted-foreground">
              {t('audit.filters.personTruncated', { count: people.data.people.length })}
            </span>
          )}
        </Field>
        <Field data-invalid={!!problems.recordType}>
          <FieldLabel htmlFor={FIELD_IDS.recordType}>{t('audit.filters.recordType')}</FieldLabel>
          <select
            id={FIELD_IDS.recordType}
            className={SELECT_CLASS}
            value={draft.recordType ?? ''}
            onChange={(event) => set('recordType')(event.target.value)}
            {...invalid('recordType')}
          >
            <option value="">{t('audit.filters.anyRecordType')}</option>
            {draft.recordType && !(draft.recordType in AUDIT_RECORD_TYPES) && (
              <option value={draft.recordType}>{draft.recordType}</option>
            )}
            {RECORD_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(AUDIT_RECORD_TYPES[type].label)}
              </option>
            ))}
          </select>
          {problem('recordType')}
        </Field>
        <Field data-invalid={!!problems.recordId}>
          <FieldLabel htmlFor={FIELD_IDS.recordId}>{t('audit.filters.recordId')}</FieldLabel>
          <Input
            id={FIELD_IDS.recordId}
            dir="ltr"
            autoComplete="off"
            value={draft.recordId ?? ''}
            onChange={(event) => set('recordId')(event.target.value)}
            {...invalid('recordId')}
          />
          {problem('recordId')}
        </Field>
        <Field data-invalid={!!problems.action}>
          <FieldLabel htmlFor={FIELD_IDS.action}>{t('audit.filters.action')}</FieldLabel>
          <select
            id={FIELD_IDS.action}
            className={SELECT_CLASS}
            value={draft.action ?? ''}
            onChange={(event) => set('action')(event.target.value)}
            {...invalid('action')}
          >
            <option value="">{t('audit.filters.anyAction')}</option>
            {draft.action && !(draft.action in AUDIT_ACTIONS) && (
              <option value={draft.action}>{text.actionCodeName(draft.action)}</option>
            )}
            {AUDIT_ACTION_CODES.map((code) => (
              <option key={code} value={code}>
                {t(AUDIT_ACTIONS[code].label)}
              </option>
            ))}
          </select>
          {problem('action')}
        </Field>
        <Field data-invalid={!!problems.dayFrom}>
          <FieldLabel htmlFor={FIELD_IDS.dayFrom}>{t('audit.filters.dayFrom')}</FieldLabel>
          <Input
            id={FIELD_IDS.dayFrom}
            type="date"
            value={draft.dayFrom ?? ''}
            onChange={(event) => set('dayFrom')(event.target.value)}
            {...invalid('dayFrom')}
          />
          {problem('dayFrom')}
        </Field>
        <Field data-invalid={!!problems.dayTo}>
          <FieldLabel htmlFor={FIELD_IDS.dayTo}>{t('audit.filters.dayTo')}</FieldLabel>
          <Input
            id={FIELD_IDS.dayTo}
            type="date"
            value={draft.dayTo ?? ''}
            onChange={(event) => set('dayTo')(event.target.value)}
            {...invalid('dayTo')}
          />
          {problem('dayTo')}
        </Field>
        <Field data-invalid={!!problems.correlationId} className="sm:col-span-2">
          <FieldLabel htmlFor={FIELD_IDS.correlationId}>
            {t('audit.filters.correlationId')}
          </FieldLabel>
          <Input
            id={FIELD_IDS.correlationId}
            dir="ltr"
            autoComplete="off"
            value={draft.correlationId ?? ''}
            onChange={(event) => set('correlationId')(event.target.value)}
            {...invalid('correlationId', CORRELATION_HINT_ID)}
          />
          <FieldDescription id={CORRELATION_HINT_ID}>
            {t('audit.filters.correlationHint')}
          </FieldDescription>
          {problem('correlationId')}
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{t('audit.filters.apply')}</Button>
        <Button type="button" variant="outline" onClick={clear}>
          {t('audit.filters.clear')}
        </Button>
      </div>
    </form>
  );
}
