'use client';

import { Popover, PopoverContent, PopoverTrigger } from '@ssdashboard/ui/components/popover';
import { StatusChip } from '@ssdashboard/ui/status/status-chip';
import { StatusChipOverflow } from '@ssdashboard/ui/status/status-chip-overflow';

type OverflowStatusesSampleProps = {
  /** The accessible name of the "+N" button, already translated. */
  label: string;
  /** The hidden statuses to list when it opens. */
  statuses: readonly { meaning: 'confirmed' | 'failed' | 'owed' | 'provisional'; label: string }[];
};

/**
 * The "+N" chip of an order row as a button that opens a popover listing the hidden statuses, so
 * a failed or owed status is never unreachable. `PopoverTrigger asChild` supplies the open state,
 * `aria-expanded`, `aria-haspopup`, and focus return to `StatusChipOverflow`, which forwards them
 * to its button. It must never be used for anything but the sample.
 */
export function OverflowStatusesSample({ label, statuses }: OverflowStatusesSampleProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <StatusChipOverflow count={statuses.length} label={label} />
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={label} className="w-auto gap-2 p-3">
        <ul className="flex flex-col items-start gap-2">
          {statuses.map((status) => (
            <li key={status.label}>
              <StatusChip meaning={status.meaning} label={status.label} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
