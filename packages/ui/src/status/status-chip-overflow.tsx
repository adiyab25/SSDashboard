import type { ComponentProps } from 'react';
import { cn } from 'cn';

type StatusChipOverflowProps = Omit<ComponentProps<'button'>, 'children' | 'type'> & {
  /** How many chips are hidden behind this one. */
  count: number;
  /** The accessible name, already translated, such as "2 more statuses". */
  label: string;
  /** Forces the button form when nothing else implies it (rare; the other props already do). */
  interactive?: boolean;
};

const CLASS_NAME =
  'inline-flex h-6 shrink-0 items-center rounded-chip border border-border-strong bg-muted px-2 font-mono text-xs font-normal whitespace-nowrap text-muted-foreground tabular-nums';

/**
 * The neutral "+N" chip that stands for the status chips a row cannot show (at most three are
 * shown). It reads `+2` visually and `label` to screen readers. It is a `<button>` when it is
 * interactive, otherwise a plain `<span>`, so a static count is never a dead control. It counts
 * as interactive when `onClick`, `interactive`, `aria-haspopup`, `aria-expanded`, or
 * `aria-controls` is present; a Radix trigger (`<PopoverTrigger asChild>`) always supplies these,
 * so that case needs no extra prop. `ref` and every other button prop (`onKeyDown`, `data-state`,
 * and so on) are forwarded to the button so Radix Slot can merge them; on the span form they are
 * dropped. It must never carry a meaning color or hide a failed or owed status without the
 * caller listing it somewhere reachable.
 *
 * Usage as a trigger: wrap it in `PopoverTrigger asChild` inside a `Popover`, passing only
 * `count` and `label`.
 */
export function StatusChipOverflow({
  count,
  label,
  interactive,
  className,
  ref,
  ...buttonProps
}: StatusChipOverflowProps) {
  const content = (
    <>
      <bdi dir="ltr" aria-hidden="true">
        +{count}
      </bdi>
      <span className="sr-only">{label}</span>
    </>
  );
  const isButton =
    interactive === true ||
    buttonProps.onClick !== undefined ||
    buttonProps['aria-haspopup'] !== undefined ||
    buttonProps['aria-expanded'] !== undefined ||
    buttonProps['aria-controls'] !== undefined;
  if (isButton) {
    return (
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        data-slot="status-chip-overflow"
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
