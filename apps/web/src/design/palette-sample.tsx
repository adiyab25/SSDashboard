'use client';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ssdashboard/ui/components/command';
import { useTranslation } from 'react-i18next';

/** A static command list, to check row height and the highlighted item. */
export function PaletteSample() {
  const { t } = useTranslation();
  return (
    <Command label={t('design.command.label')} className="max-w-sm rounded-card border">
      <CommandInput placeholder={t('design.command.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('design.command.empty')}</CommandEmpty>
        <CommandGroup heading={t('design.command.pages')}>
          <CommandItem>{t('design.command.one')}</CommandItem>
          <CommandItem>{t('design.command.two')}</CommandItem>
          <CommandItem>{t('design.command.three')}</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

/** Mirrored sample, inside its own Radix direction so portals mirror too. */
