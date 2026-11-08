'use client';

import { moduleKeyOfToggle, type SettingEntryView } from '@ssdashboard/contracts';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModuleStates } from '@/shell/use-module-states';
import { ModuleOffDialog } from './module-off-dialog';
import { ModuleSwitchRow } from './module-switch-row';
import { SettingChangeDialog } from './setting-change-dialog';

/**
 * The module switches inside the Modules and license section (spec 0009, AC-12, AC-25): one row
 * per entry of the settings group `modules` with its effective state from
 * `GET /api/platform/modules`. Turning a module off opens the off dialog (impact, typed
 * confirmation, reason); turning one on opens the change dialog started at `true`. It draws
 * nothing while no module is toggleable (today none is). It has no heading of its own: the
 * section's `h2` holds it, its `h3` "Module switches" names the list, and each row has its own `h4`.
 */
export function ModuleSwitchSection({ entries }: { entries: readonly SettingEntryView[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  const { stateOf } = useModuleStates();
  const [turningOff, setTurningOff] = useState<SettingEntryView | null>(null);
  const [turningOn, setTurningOn] = useState<SettingEntryView | null>(null);
  if (entries.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="text-sm font-semibold">
        {t('settings.sections.modules')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('settings.modules.description')}</p>
      <ul aria-labelledby={headingId} className="divide-y rounded-lg border">
        {entries.map((entry) => {
          const key = moduleKeyOfToggle(entry.key);
          return (
            <ModuleSwitchRow
              key={entry.key}
              entry={entry}
              view={key === undefined ? null : stateOf(key)}
              onToggle={entry.value === true ? setTurningOff : setTurningOn}
            />
          );
        })}
      </ul>
      {turningOff && <ModuleOffDialog entry={turningOff} onClose={() => setTurningOff(null)} />}
      {turningOn && (
        <SettingChangeDialog
          entry={turningOn}
          initialValue={true}
          onClose={() => setTurningOn(null)}
        />
      )}
    </div>
  );
}
