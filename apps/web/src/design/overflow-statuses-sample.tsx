'use client';

import { Popover, PopoverAnchor, PopoverContent } from '@ssdashboard/ui/components/popover';
import { StatusChip } from '@ssdashboard/ui/status/status-chip';
import { StatusChipOverflow } from '@ssdashboard/ui/status/status-chip-overflow';
import { useEffect, useRef, useState } from 'react';

type OverflowStatusesSampleProps = {
  /** The accessible name of the "+N" button, already translated. */
  label: string;
  /** The hidden statuses to list when it opens. */
  statuses: readonly { meaning: 'confirmed' | 'failed' | 'owed' | 'provisional'; label: string }[];
};

/**
 * The "+N" chip of an order row as a button that opens a popover listing the hidden statuses, so
 * a failed or owed status is never unreachable. `StatusChipOverflow` does not forward trigger
 * props, so the open state is held here and mirrored to `aria-expanded` on its button. It must
 * never be used for anything but the sample: a product screen needs the component to carry
 * those attributes itself.
 */
export function OverflowStatusesSample({ label, statuses }: OverflowStatusesSampleProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const button = anchorRef.current?.querySelector('button');
    button?.setAttribute('aria-expanded', String(open));
    button?.setAttribute('aria-haspopup', 'dialog');
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span ref={anchorRef} className="inline-flex">
          <StatusChipOverflow
            count={statuses.length}
            label={label}
            onClick={() => setOpen((current) => !current)}
          />
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        aria-label={label}
        className="w-auto gap-2 p-3"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          anchorRef.current?.querySelector('button')?.focus();
        }}
      >
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
