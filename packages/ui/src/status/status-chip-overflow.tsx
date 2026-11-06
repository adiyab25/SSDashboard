import { cn } from 'cn';

type StatusChipOverflowProps = {
  /** How many chips are hidden behind this one. */
  count: number;
  /** The accessible name, already translated, such as "2 more statuses". */
  label: string;
  /** When given, the chip is a button that opens the full list; otherwise it is plain text. */
  onClick?: () => void;
  className?: string;
};

const CLASS_NAME =
  'inline-flex h-6 shrink-0 items-center rounded-sm bg-muted px-2 text-xs font-medium whitespace-nowrap text-muted-foreground tabular-nums';

/**
 * The neutral "+N" chip that stands for the status chips a row cannot show (at most three are
 * shown). It reads `+2` visually and `label` to screen readers. It is a button only when
 * `onClick` is passed, so a static count is never a dead control. It must never carry a meaning
 * color or hide a failed or owed status without the caller listing it somewhere reachable.
 */
export function StatusChipOverflow({ count, label, onClick, className }: StatusChipOverflowProps) {
  const content = (
    <>
      <bdi dir="ltr" aria-hidden="true">
        +{count}
      </bdi>
      <span className="sr-only">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        data-slot="status-chip-overflow"
        onClick={onClick}
        className={cn(CLASS_NAME, 'focus-ring hover:bg-accent', className)}
      >
        {content}
      </button>
    );
  }
  return (
    <span data-slot="status-chip-overflow" className={cn(CLASS_NAME, className)}>
      {content}
    </span>
  );
}
