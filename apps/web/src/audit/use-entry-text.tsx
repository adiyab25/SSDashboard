'use client';

import { auditUndoneParentOf, type AuditEntryView } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ACTOR_KIND_KEYS, actionLabelKey, recordTypeLabelKey } from './audit-labels';

/** What one entry says about who, what, and which record, ready to render. */
export interface EntryText {
  /** The person's name, the actor kind with its reference, or "Unknown person". */
  actor: (entry: AuditEntryView) => ReactNode;
  /** The action label from the registry in the viewer's language, or the raw code. */
  action: (entry: AuditEntryView) => ReactNode;
  /** The action label as plain text, for an accessible name. */
  actionName: (entry: AuditEntryView) => string;
  /**
   * The label of an action code as plain text (an undone code names the action it undid), for a
   * picker option, or the raw code when the registry does not know it.
   */
  actionCodeName: (code: string) => string;
  /** The record type label with the record's label under it. */
  record: (entry: AuditEntryView) => ReactNode;
}

/**
 * The wording of an audit entry, shared by the list, the history panel, and the detail so the
 * three never name an actor or an action differently. Unknown actions and record types show their
 * code instead of failing. Never reads the api.
 */
export function useEntryText(): EntryText {
  const { t } = useTranslation();

  function codeName(code: string): string {
    const key = actionLabelKey(code);
    if (!key) return code;
    const parent = auditUndoneParentOf(code)?.code;
    const parentKey = parent ? actionLabelKey(parent) : undefined;
    return parentKey ? t('audit.undo.named', { undone: t(key), action: t(parentKey) }) : t(key);
  }

  return {
    actor(entry) {
      if (entry.actorName) return entry.actorName;
      if (entry.actor.kind === 'person') return t('audit.unknownPerson');
      return (
        <>
          {t(ACTOR_KIND_KEYS[entry.actor.kind])}
          {entry.actor.ref ? (
            <>
              {' '}
              <LtrText>{entry.actor.ref}</LtrText>
            </>
          ) : null}
        </>
      );
    },
    action(entry) {
      const key = actionLabelKey(entry.action);
      if (!key) return <LtrText>{entry.action}</LtrText>;
      const parent = auditUndoneParentOf(entry.action)?.code;
      const parentKey = parent ? actionLabelKey(parent) : undefined;
      return parentKey ? (
        <span className="flex flex-col">
          <span>{t(key)}</span>
          <span className="text-xs font-normal text-muted-foreground">{t(parentKey)}</span>
        </span>
      ) : (
        t(key)
      );
    },
    actionName(entry) {
      return codeName(entry.action);
    },
    actionCodeName: codeName,
    record(entry) {
      const key = recordTypeLabelKey(entry.record.type);
      return (
        <span className="flex flex-col">
          <span className="text-xs text-muted-foreground">
            {key ? t(key) : <LtrText>{entry.record.type}</LtrText>}
          </span>
          {entry.record.label ? <LtrText>{entry.record.label}</LtrText> : null}
        </span>
      );
    },
  };
}
