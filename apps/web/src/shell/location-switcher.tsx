'use client';

import { Button } from '@ssdashboard/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ssdashboard/ui/components/command';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Popover, PopoverContent, PopoverTrigger } from '@ssdashboard/ui/components/popover';
import { CheckIcon, ChevronsUpDownIcon, MapPinIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/i18n/language-provider';
import {
  locationName,
  useLocationSwitcher,
  type LocationChoice,
} from './current-location-provider';

/** Pick the warehouse or shop you're working in; searchable, with "All locations" first. */
export function LocationSwitcher() {
  const { t } = useTranslation();
  const { language, config } = useLanguage();
  const order = {
    active: language,
    fallback: config?.defaultLanguage ?? 'en',
    enabled: config?.languages,
  };
  const { current, locations, status, retry, setCurrentLocation } = useLocationSwitcher();
  const [open, setOpen] = useState(false);

  const selected = locations.find((location) => location.id === current);
  const label =
    status === 'empty'
      ? t('shell.locations.noneYet')
      : status === 'error'
        ? t('shell.locations.error')
        : selected
          ? locationName(selected, order)
          : t('shell.locations.all');

  const choose = (choice: LocationChoice) => {
    setCurrentLocation(choice);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="coarse:min-h-touch max-w-56 justify-between gap-2 max-sm:max-w-28"
          disabled={status === 'empty'}
        >
          {status === 'error' ? (
            <TriangleAlertIcon aria-hidden className="text-destructive" data-icon="inline-start" />
          ) : (
            <MapPinIcon aria-hidden data-icon="inline-start" />
          )}
          <span className="sr-only">{t('shell.locations.label')}: </span>
          <span className="truncate">{label}</span>
          <ChevronsUpDownIcon aria-hidden className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 max-w-[calc(100vw-2rem)] p-0"
        aria-label={t('shell.locations.label')}
      >
        {status === 'error' ? (
          <div className="flex flex-col items-start gap-3 p-3" role="alert">
            <p>{t('shell.locations.errorDetail')}</p>
            <Button
              variant="outline"
              size="sm"
              className="coarse:min-h-touch"
              onClick={() => retry()}
            >
              {t('shell.locations.retry')}
            </Button>
          </div>
        ) : (
          <Command label={t('shell.locations.search')}>
            <CommandInput placeholder={t('shell.locations.search')} />
            <CommandList>
              <CommandEmpty>
                {status === 'loading'
                  ? t('shell.locations.loading')
                  : t('shell.locations.noResults')}
              </CommandEmpty>
              <CommandGroup heading={t('shell.locations.count', { count: locations.length })}>
                <CommandItem
                  value={`all ${t('shell.locations.all')}`}
                  className="coarse:min-h-touch"
                  onSelect={() => choose('all')}
                >
                  <CheckIcon aria-hidden className={current === 'all' ? '' : 'invisible'} />
                  {t('shell.locations.all')}
                </CommandItem>
                {locations.map((location) => (
                  <CommandItem
                    key={location.id}
                    value={`${location.code} ${locationName(location, order)}`}
                    className="coarse:min-h-touch"
                    onSelect={() => choose(location.id)}
                  >
                    <CheckIcon aria-hidden className={current === location.id ? '' : 'invisible'} />
                    <span className="truncate">{locationName(location, order)}</span>
                    <LtrText className="ms-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                      {location.code}
                    </LtrText>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
