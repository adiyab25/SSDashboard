'use client';

import { Input } from '@ssdashboard/ui/components/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@ssdashboard/ui/components/input-group';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { SearchIcon } from 'lucide-react';

/** Text input and textarea in their default, invalid, disabled and described states. */
export function FieldStates() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {(['default', 'hover', 'focus'] as const).map((state) => (
        <div key={state} className="flex flex-col gap-1.5">
          <label htmlFor={`sku-${state}`} className="font-medium">
            SKU ({state})
          </label>
          <Input
            id={`sku-${state}`}
            placeholder="e.g. TBL-OAK-120"
            tabIndex={-1}
            data-state-preview={state === 'default' ? undefined : state}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sku-disabled" className="font-medium">
          SKU (disabled)
        </label>
        <Input id="sku-disabled" disabled defaultValue="TBL-OAK-120" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sku-invalid" className="font-medium">
          SKU (invalid)
        </label>
        <Input id="sku-invalid" aria-invalid defaultValue="TBL OAK" aria-describedby="sku-error" />
        <span id="sku-error" className="text-xs text-destructive">
          Use letters, numbers, and dashes only.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="product-search" className="font-medium">
          Search with an addon
        </label>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput id="product-search" placeholder="Search products" />
        </InputGroup>
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
        <label htmlFor="note" className="font-medium">
          Note
        </label>
        <Textarea id="note" placeholder="Anything the warehouse should know" />
      </div>
    </div>
  );
}
