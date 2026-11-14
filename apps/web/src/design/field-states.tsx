'use client';

import { Input } from '@ssdashboard/ui/components/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@ssdashboard/ui/components/input-group';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { SearchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Text input and textarea in their default, invalid, disabled and described states. */
export function FieldStates() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {(['default', 'hover', 'focus'] as const).map((state) => (
        <div key={state} className="flex flex-col gap-1.5">
          <label htmlFor={`sku-${state}`} className="font-medium">
            {t('design.fields.sku', { state: t(`design.fields.states.${state}`) })}
          </label>
          <Input
            id={`sku-${state}`}
            placeholder={t('design.fields.skuPlaceholder')}
            tabIndex={-1}
            data-state-preview={state === 'default' ? undefined : state}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sku-disabled" className="font-medium">
          {t('design.fields.sku', { state: t('design.fields.states.disabled') })}
        </label>
        <Input id="sku-disabled" disabled defaultValue="TBL-OAK-120" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sku-invalid" className="font-medium">
          {t('design.fields.sku', { state: t('design.fields.states.invalid') })}
        </label>
        <Input id="sku-invalid" aria-invalid defaultValue="TBL OAK" aria-describedby="sku-error" />
        <span id="sku-error" className="text-xs text-destructive">
          {t('design.fields.skuError')}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="product-search" className="font-medium">
          {t('design.fields.search')}
        </label>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput id="product-search" placeholder={t('design.fields.searchPlaceholder')} />
        </InputGroup>
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
        <label htmlFor="note" className="font-medium">
          {t('design.fields.note')}
        </label>
        <Textarea id="note" placeholder={t('design.fields.notePlaceholder')} />
      </div>
    </div>
  );
}
