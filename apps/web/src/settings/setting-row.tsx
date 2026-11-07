'use client';

import type { SettingEntryView } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { LockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { displayValue, isCodeKind, valueKindOf } from './setting-value';
import { useSettingWords } from './use-setting-words';

/** Props of `SettingRow`. */
interface SettingRowProps {
  entry: SettingEntryView;
  /** Opens the change dialog for this entry. */
  onChange: (entry: SettingEntryView) => void;
}

/**
 * One setting in a section (spec 0009, AC-25): its name and description, the value in force, the
 * default and whether the value is the default, who changed it last and when, and a Change
 * button. An entry that cannot be changed here, or whose bundle is not licensed, has no active
 * button and says why in words. The licensed gate is the screen's alone until the api refuses an
 * unlicensed write too (security review S6, milestone 2 or 3); `canChange` is enforced by the api
 * (409 `SETTING_LOCKED`). It never decides what may change.
 */
export function SettingRow({ entry, onChange }: SettingRowProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const words = useSettingWords();
  const kind = valueKindOf(entry);
  const name = t(entry.label as MessageKey);
  const codes = isCodeKind(kind);
  const show = (value: SettingEntryView['value']) => {
    const text = displayValue(value, kind, words);
    return codes && value !== null ? <LtrText>{text}</LtrText> : text;
  };

  const blocked = !entry.canChange
    ? t('settings.row.fixed')
    : !entry.licensed
      ? t(
          entry.bundle === 'operations'
            ? 'settings.row.needsOperations'
            : 'settings.row.needsWarehouse',
        )
      : null;

  const when = entry.updatedAt ? format.dateTime(entry.updatedAt) : null;
  const who = entry.updatedBy ? (entry.updatedBy.name ?? t('settings.row.unknownPerson')) : null;

  return (
    <li className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{name}</h3>
          <Badge variant={entry.isDefault ? 'secondary' : 'outline'}>
            {entry.isDefault ? t('settings.row.isDefault') : t('settings.row.changed')}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t(entry.description as MessageKey)}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('settings.row.valueLabel')}</dt>
          <dd className="min-w-0 break-words font-medium">{show(entry.value)}</dd>
          <dt className="text-muted-foreground">{t('settings.row.defaultLabel')}</dt>
          <dd className="min-w-0 break-words">{show(entry.default)}</dd>
        </dl>
        {entry.invalid && <p className="text-sm text-destructive">{t('settings.row.invalid')}</p>}
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
          disabled={blocked !== null}
          aria-label={t('settings.row.changeNamed', { name })}
          onClick={() => onChange(entry)}
        >
          {t('settings.row.change')}
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
