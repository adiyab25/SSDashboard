'use client';

import type { ReactNode } from 'react';
import { CircleQuestionMark } from 'lucide-react';
import { cn } from 'cn';
import { Popover, PopoverContent, PopoverTrigger } from '@ssdashboard/ui/components/popover';

type HelpHintProps = {
  /**
   * The accessible name of the button and of the popover, already translated, and it must say
   * what is explained ("Help: callback delay"), never a bare "Help".
   */
  label: string;
  /** One or two sentences, already translated (policy numbers read from settings). */
  children: ReactNode;
  className?: string;
};

/**
 * The smallest layer of in screen help (AC-21): a question mark button that opens a popover of
 * one or two sentences next to a field, a column header, or an outcome. It is a real button, so
 * tap, Enter, and Space open it and Esc closes it with focus back on the button; nothing depends
 * on hover. The button is 24 by 24px (44 by 44px on touch). It must never hold an instruction the
 * user has to follow (help is never the only copy), and it holds no text of its own.
 */
export function HelpHint({ label, children, className }: HelpHintProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-slot="help-hint"
          className={cn(
            'focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground coarse:size-11',
            className,
          )}
        >
          <CircleQuestionMark aria-hidden="true" className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={label} className="gap-2">
        {children}
      </PopoverContent>
    </Popover>
  );
}
