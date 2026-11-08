'use client';

import {
  NO_STOCK_OUT_SOURCE,
  type ModuleStateView,
  type SettingEntryView,
} from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { BellIcon, BellOffIcon, CircleSlashIcon, LockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { REASON_KEYS } from '@/shell/module-reason-text';
import { useCustomerWords } from './use-customer-words';
import { usePreconditionText } from './use-precondition-text';

/** Props of `AutomationRow`. */
interface AutomationRowProps {
  /** An `executing_step` entry: `step` carries its capability, customer flag, and turn on check. */
  entry: SettingEntryView;
  /** The state of the capability the step gates, or null while the module states are not in. */
  capability: ModuleStateView | null;
  /** Opens the turn on dialog (the step is off) or the off dialog (the step is on). */
  onToggle: (entry: SettingEntryView) => void;
}

/**
 * One executing step in the Automations section (spec 0009, AC-21, AC-25): its name, what the app
 * does when it is on, whether the customer hears about it (for a Shopify write, that Shopify does
 * not email the customer), its switch, and one button. A step that cannot be switched on yet says
 * why in plain words (waiting for a stock out source, wave 1 review W9) and its Turn on button is
 * unavailable; a step that is on while its capability is not running says that too. It never
 * decides what may change: the api answers 403 and 409.
 */
export function AutomationRow({ entry, capability, onToggle }: AutomationRowProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const words = usePreconditionText();
  const customerWords = useCustomerWords();
  const name = t(entry.label as MessageKey);
  const step = entry.step ?? null;
  const switchedOn = entry.value === true;
  // Why it cannot be switched on: the check the list carried, or (should the two disagree) the
  // capability itself waiting for a stock out source (AC-29).
  const waiting = switchedOn
    ? null
    : step !== null && !step.turnOn.ready
      ? step.turnOn.precondition
      : capability?.state === 'read_only' && capability.reason === 'no_stock_out_source'
        ? NO_STOCK_OUT_SOURCE
        : null;
  const notRunning =
    switchedOn && capability !== null && capability.state !== 'on' && capability.state !== 'limited'
      ? capability
      : null;

  const blocked = !entry.canChange
    ? t('settings.row.fixed')
    : !entry.licensed
      ? t(
          entry.bundle === 'operations'
            ? 'settings.row.needsOperations'
            : 'settings.row.needsWarehouse',
        )
      : null;

  const customer = step === null ? null : customerWords(step);

  const when = entry.updatedAt ? format.dateTime(entry.updatedAt) : null;
  const who = entry.updatedBy ? (entry.updatedBy.name ?? t('settings.row.unknownPerson')) : null;

  return (
    <li className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{name}</h3>
          <Badge variant={switchedOn ? 'secondary' : 'outline'}>
            {switchedOn
              ? t('settings.automations.on')
              : waiting !== null
                ? t('settings.automations.unavailable')
                : t('settings.automations.off')}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t(entry.description as MessageKey)}</p>
        {customer && (
          <p className="flex items-center gap-1.5 text-sm">
            {step?.notifiesCustomer ? (
              <BellIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <BellOffIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            {customer}
          </p>
        )}
        {waiting !== null && (
          <p className="flex items-start gap-1.5 text-sm">
            <CircleSlashIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {words.precondition(waiting)}
          </p>
        )}
        {notRunning && (
          <p className="text-sm">
            {t('settings.automations.notRunning')}
            {notRunning.reason && ` ${t(REASON_KEYS[notRunning.reason])}`}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {when === null
            ? t('settings.row.neverChanged')
            : who !== null
              ? t('settings.row.lastChanged', { name: who, date: when })
              : t('settings.row.lastChangedUnknown', { date: when })}
        </p>
      </div>
      <div className="flex flex-col gap-1 md:items-end">
        <Button
          variant="outline"
          size="sm"
          disabled={blocked !== null || waiting !== null}
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
