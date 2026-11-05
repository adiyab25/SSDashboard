'use client';

import { Button } from '@ssdashboard/ui/components/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@ssdashboard/ui/components/input-group';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { Direction } from 'radix-ui';

/** A row of controls under a right to left direction, to check mirroring. */
export function RightToLeftRow() {
  return (
    <Direction.Provider dir="rtl">
      <div dir="rtl" className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <Button>
          Next
          <ChevronRightIcon aria-hidden className="rtl:-scale-x-100" data-icon="inline-end" />
        </Button>
        <Button variant="outline">Back</Button>
        <InputGroup className="max-w-64">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput aria-label="Search, right to left" placeholder="Search" />
        </InputGroup>
      </div>
    </Direction.Provider>
  );
}
