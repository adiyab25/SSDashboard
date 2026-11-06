'use client';

import { Check, Circle, X } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@ssdashboard/ui/components/button';

const ROW_CLASS = 'flex min-h-9 items-center gap-2 py-1 text-sm coarse:min-h-11';

type FirstRunChecklistItem = {
  /** The already translated first action ("Confirm your first order"). */
  label: string;
  /** Whether the user has done it; the app derives this from real events, not from clicks here. */
  done: boolean;
  /** Where to do it (optional); the row is then a link. */
  href?: string;
};

type FirstRunChecklistProps = {
  /** The visible title and accessible name, already translated ("Your first steps"). */
  title: string;
  items: FirstRunChecklistItem[];
  /** The progress text, already formatted by the app ("2 of 4"). */
  progressLabel: string;
  /** Screen reader word for a finished item ("Done"). */
  doneLabel: string;
  /** Screen reader word for an open item ("To do"). */
  todoLabel: string;
  /** The accessible name of the dismiss button ("Hide the checklist"). */
  dismissLabel: string;
  /** Called when the user dismisses; the app stores that per user and hat. */
  onDismiss: () => void;
  className?: string;
};

/**
 * The first run checklist for one hat (agent, warehouse, lead, owner) (AC-21): a short list of
 * the first actions with a progress count and a dismiss button. It is controlled: the app passes
 * the items and `done` flags, stores the dismissal, and unmounts it. To bring it back, the app
 * puts its own "show the checklist again" button in `HelpPanel`'s `footer` and clears the stored
 * dismissal; this component has no memory. Progress is also a `progressbar` for screen readers.
 * It must never decide `done` itself, persist anything, or hold the only copy of an instruction.
 */
export function FirstRunChecklist({
  title,
  items,
  progressLabel,
  doneLabel,
  todoLabel,
  dismissLabel,
  onDismiss,
  className,
}: FirstRunChecklistProps) {
  const doneCount = items.filter((item) => item.done).length;
  const percent = items.length === 0 ? 0 : Math.round((doneCount / items.length) * 100);
  return (
    <section
      aria-label={title}
      data-slot="first-run-checklist"
      className={cn('rounded-lg border bg-card p-4 text-card-foreground', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground tabular-nums">{progressLabel}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="coarse:size-11"
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
          <span className="sr-only">{dismissLabel}</span>
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label={progressLabel}
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={doneCount}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary" style={{ inlineSize: `${percent}%` }} />
      </div>
      <ul className="mt-3 flex flex-col">
        {items.map((item) => {
          const content = (
            <>
              {item.done ? (
                <Check aria-hidden="true" className="size-4 shrink-0 text-confirmed" />
              ) : (
                <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="sr-only">{item.done ? doneLabel : todoLabel}</span>
              <span className={cn('min-w-0 flex-1', item.done && 'text-muted-foreground')}>
                {item.label}
              </span>
            </>
          );
          return (
            <li key={item.label}>
              {item.href && !item.done ? (
                <a
                  href={item.href}
                  className={cn(ROW_CLASS, 'focus-ring rounded-sm hover:underline')}
                >
                  {content}
                </a>
              ) : (
                <div className={ROW_CLASS}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
