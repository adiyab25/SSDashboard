'use client';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ssdashboard/ui/components/command';

/** A static command list, to check row height and the highlighted item. */
export function PaletteSample() {
  return (
    <Command label="Sample palette" className="max-w-sm rounded-lg border">
      <CommandInput placeholder="Search pages…" />
      <CommandList>
        <CommandEmpty>No pages match.</CommandEmpty>
        <CommandGroup heading="Pages">
          <CommandItem>Stock levels</CommandItem>
          <CommandItem>Transfers</CommandItem>
          <CommandItem>Purchase orders</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

/** Mirrored sample, inside its own Radix direction so portals mirror too. */
