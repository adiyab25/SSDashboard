import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { StatusChip } from '../status/status-chip';
import type { StatusMeaning } from '../lib/status-meaning';

/** The most rows the list draws; the rest hide behind the "N more" link. */
export const NEEDS_YOU_MAX_ROWS = 5;

type NeedsYouItem = {
  /** A stable key, such as the order code. */
  id: string;
  /** The screen this row opens (the exact order, queue, or cash page). */
  href: string;
  /** The already translated sentence, such as "TBL-OAK-120 has no answer after 3 calls". */
  label: string;
  /** The meaning role of the chip. */
  meaning: StatusMeaning;
  /** The chip word, already translated. */
  chipLabel: string;
};

type NeedsYouListProps = {
  /** The accessible name of the list, already translated ("Needs you"). */
  label: string;
  /** The rows, most urgent first; only the first five are drawn. */
  items: NeedsYouItem[];
  /** How many rows exist in all, when the list was cut by the api. Defaults to `items.length`. */
  total?: number;
  /** The page with the whole list; the "N more" link shows only when there are hidden rows. */
  moreHref?: string;
  /** Builds the already translated link text from the hidden count ("3 more"). */
  moreLabel?: (hiddenCount: number) => string;
  className?: string;
};

/**
 * The "Needs you" list under the dashboard cards: at most five rows, each a full width link at
 * least 48px tall with a `StatusChip`, a sentence, and a decorative chevron that mirrors in right
 * to left (AC-20). When more exist, one "N more" link goes to the full list. It must never draw a
 * sixth row, hide a row behind hover, or compose text itself.
 */
export function NeedsYouList({
  label,
  items,
  total,
  moreHref,
  moreLabel,
  className,
}: NeedsYouListProps) {
  const rows = items.slice(0, NEEDS_YOU_MAX_ROWS);
  const hidden = Math.max(total ?? 0, items.length) - rows.length;
  const rowClass =
    'focus-ring-inset flex min-h-12 w-full items-center gap-3 px-3 py-2 text-sm hover:tint-row';
  return (
    <ul
      aria-label={label}
      data-slot="needs-you-list"
      className={cn('divide-y overflow-hidden rounded-card border bg-card', className)}
    >
      {rows.map((item) => (
        <li key={item.id}>
          <a href={item.href} className={rowClass}>
            <StatusChip meaning={item.meaning} label={item.chipLabel} />
            <span className="min-w-0 flex-1">{item.label}</span>
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
            />
          </a>
        </li>
      ))}
      {hidden > 0 && moreHref && moreLabel ? (
        <li>
          <a href={moreHref} className={cn(rowClass, 'font-medium text-primary')}>
            <span className="flex-1">{moreLabel(hidden)}</span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 rtl:-scale-x-100" />
          </a>
        </li>
      ) : null}
    </ul>
  );
}
