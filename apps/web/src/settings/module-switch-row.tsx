'use client';

import type { ModuleStateView, SettingEntryView } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { REASON_KEYS } from '@/shell/module-reason-text';

/** Props of `ModuleSwitchRow`. */
interface ModuleSwitchRowProps {
  entry: SettingEntryView;
  /** The module's effective state, or null while the states are not in. */
  view: ModuleStateView | null;
  /** Opens the off dialog (the switch is on) or the change dialog (the switch is off). */
  onToggle: (entry: SettingEntryView) => void;
}

/**
 * One module switch in the Modules section (spec 0009, AC-12, AC-25): the module's name and
 * description, its effective state in words with the reason and date (a switch that is on can
 * still be `read_only` or `off` for a license reason), and one button: Turn off (which opens the
 * off dialog) or Turn on. A switch that cannot be changed, or whose plan is not licensed, has no
 * active button and says why. It never decides what may change: the api answers 403 and 409.
 */
export function ModuleSwitchRow({ entry, view, onToggle }: ModuleSwitchRowProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const name = t(entry.label as MessageKey);
  const switchedOn = entry.value === true;
  const blocked = !entry.canChange
    ? t('settings.row.fixed')
    : !entry.licensed
      ? t(
          entry.bundle === 'operations'
            ? 'settings.row.needsOperations'
            : 'settings.row.needsWarehouse',
        )
      : null;
  const since =
    view !== null && view.state !== 'on' && view.since !== null
      ? format.dateTime(view.since)
      : null;

  return (
    <li className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-medium">{name}</h4>
          <Badge variant={view?.state === 'on' ? 'secondary' : 'outline'}>
            {view
              ? t(`shell.modules.states.${view.state}`)
              : switchedOn
                ? t('shell.modules.states.on')
                : t('shell.modules.states.off')}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t(entry.description as MessageKey)}</p>
        {view && view.state !== 'on' && (
          <p className="text-sm text-muted-foreground">
            {view.reason && t(REASON_KEYS[view.reason])}
            {since && ` ${t('shell.modules.since', { date: since })}`}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1 md:items-end">
        <Button
          variant="outline"
          size="sm"
          disabled={blocked !== null}
          aria-label={t(
            switchedOn ? 'settings.modules.row.turnOffNamed' : 'settings.modules.row.turnOnNamed',
            { name },
          )}
          onClick={() => onToggle(entry)}
        >
          {t(switchedOn ? 'settings.modules.row.turnOff' : 'settings.modules.row.turnOn')}
        </Button>
        {blocked && (
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <LockIcon aria-hidden className="size-3.5" />
            {blocked}
          </p>
        )}
      </div>
    </li>
  );
}
