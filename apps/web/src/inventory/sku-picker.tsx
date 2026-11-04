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
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useEffect, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { inventoryKeys, searchSkus } from './inventory-api';

/** The SKU a receipt line names, with what the picker shows. */
export interface PickedSku {
  id: string;
  code: string;
  name: { en?: string; ar?: string };
}

const SEARCH_DELAY_MS = 250;

interface Props {
  id: string;
  value: PickedSku | null;
  onChange: (sku: PickedSku) => void;
  onBlur?: () => void;
  invalid?: boolean;
  describedBy?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

/**
 * A searchable SKU combobox for receipt lines: up to 20 active SKUs by code prefix or name
 * (spec 0006, AC-13). Keyboard: Enter or Space opens it, arrows move, Enter picks, Esc closes.
 */
export function SkuPicker({ id, value, onChange, onBlur, invalid, describedBy, buttonRef }: Props) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(input.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [input]);

  const results = useQuery({
    queryKey: inventoryKeys.skuSearch(q),
    queryFn: ({ signal }) => searchSkus(q, signal),
    enabled: open,
  });

  // Results for older text never show, so Enter can only pick a match for what was typed.
  const pending = input.trim() !== q || (results.isFetching && !results.data);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onBlur?.();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={buttonRef}
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="w-full min-w-0 justify-between font-normal"
        >
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              <LtrText className="font-medium">{value.code}</LtrText>
              <span className="truncate text-muted-foreground">{text(value.name, value.code)}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{t('inventory.receipt.chooseSku')}</span>
          )}
          <ChevronsUpDownIcon aria-hidden className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            value={input}
            onValueChange={setInput}
            placeholder={t('inventory.receipt.searchSku')}
          />
          <CommandList>
            {pending ? (
              <div className="px-3 py-4 text-sm text-muted-foreground" role="status">
                {t('inventory.receipt.searching')}
              </div>
            ) : (
              <CommandEmpty>{t('inventory.receipt.noSkus')}</CommandEmpty>
            )}
            <CommandGroup>
              {(pending ? [] : (results.data?.items ?? [])).map((sku) => (
                <CommandItem
                  key={sku.id}
                  value={sku.id}
                  className="coarse:min-h-touch"
                  onSelect={() => {
                    onChange({ id: sku.id, code: sku.code, name: sku.name });
                    setOpen(false);
                    onBlur?.();
                  }}
                >
                  <CheckIcon aria-hidden className={value?.id === sku.id ? '' : 'invisible'} />
                  <LtrText className="font-medium">{sku.code}</LtrText>
                  <span className="truncate text-muted-foreground">{text(sku.name, sku.code)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
