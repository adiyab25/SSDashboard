'use client';

import type { SettingEntryView } from '@ssdashboard/contracts';
import { ZapOffIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModuleStates } from '@/shell/use-module-states';
import { AutomationRow } from './automation-row';
import { ModuleOffDialog } from './module-off-dialog';
import { StepOnDialog } from './step-on-dialog';

/**
 * The Automations section of the settings screen (spec 0009, AC-21, AC-25, AC-30): one row per
 * executing step entry (group `automations`), each with the state of the capability it gates from
 * `GET /api/platform/modules`. Turning a step on opens the turn on dialog in plain words; turning
 * one off opens the off dialog with its impact. With no step on this install (none is built yet)
 * it shows the empty pattern saying each arrives switched off with the feature that does the work.
 */
export function AutomationSection({ entries }: { entries: readonly SettingEntryView[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  const { stateOf } = useModuleStates();
  const [turningOn, setTurningOn] = useState<SettingEntryView | null>(null);
  const [turningOff, setTurningOff] = useState<SettingEntryView | null>(null);

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {t('settings.sections.automations')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('settings.automations.description')}</p>
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border px-4 py-8 text-center">
          <ZapOffIcon aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('settings.automations.empty')}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {entries.map((entry) => (
            <AutomationRow
              key={entry.key}
              entry={entry}
              capability={entry.step ? stateOf(entry.step.capability) : null}
              onToggle={entry.value === true ? setTurningOff : setTurningOn}
            />
          ))}
        </ul>
      )}
      {turningOn && (
        <StepOnDialog
          entry={turningOn}
          capability={turningOn.step ? stateOf(turningOn.step.capability) : null}
          onClose={() => setTurningOn(null)}
        />
      )}
      {turningOff && (
        <ModuleOffDialog
          entry={turningOff}
          confirmHintKey="settings.automations.confirmHint"
          onClose={() => setTurningOff(null)}
        />
      )}
    </section>
  );
}
