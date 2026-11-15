'use client';

import * as React from 'react';
import { cn } from 'cn';

/**
 * The wrapper scrolls horizontally on narrow screens, so it must be keyboard
 * reachable (WCAG 2.1.1, axe scrollable-region-focusable): tabIndex 0, a named
 * region (it reuses the table's own aria-label / aria-labelledby), and an inset
 * focus ring (an outer ring would be clipped by overflow).
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  const { 'aria-label': label, 'aria-labelledby': labelledBy } = props;
  return (
    <div
      data-slot="table-container"
      role="region"
      aria-label={label}
      aria-labelledby={labelledBy}
      // Intentional: scrollable regions must be focusable (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="relative w-full overflow-x-auto outline-none focus-ring-inset"
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  );
}

/** Table head section; wraps header rows. */
function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('bg-muted [&_tr]:border-b [&_tr]:border-border-strong', className)}
      {...props}
    />
  );
}

/** Table body section; wraps data rows. */
function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

/** Table foot section, for totals. */
function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

/** One table row with hover and selected states. */
function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'h-row border-b transition-colors hover:tint-row has-aria-expanded:tint-row data-[state=selected]:gradient-selected-row',
        className,
      )}
      {...props}
    />
  );
}

/** Column header cell. */
function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'table-head-look h-row-header px-2 text-start align-middle whitespace-nowrap [&:has([role=checkbox])]:pe-0',
        className,
      )}
      {...props}
    />
  );
}

/** Matches a vertical padding class (`p-`, `py-`, `pt-`, `pb-`), with or without a variant or `!` before it. */
const ownVerticalPadding = /(?:^|[\s:\]!])-?(?:p|py|pt|pb)-\S/;

/**
 * Data cell. Adds the Arabic trim (`[&:lang(ar)]:py-1`, so a single line Arabic row stays 40px
 * on its 28px line) only when the caller's `className` sets no vertical padding of its own. Any
 * `p-`, `py-`, `pt-` or `pb-` class counts, variant prefixed ones too (`sm:py-0`,
 * `[&:lang(ar)]:py-0`); `px-`, `ps-` and `pe-` do not. Why: the variant class has a higher
 * specificity than a plain `py-10` and tailwind-merge does not dedupe across variants, so an
 * always-on trim would beat the caller's padding in Arabic. It must never be applied on top of
 * a caller's vertical padding.
 */
function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  const arabicTrim = ownVerticalPadding.test(className ?? '') ? undefined : '[&:lang(ar)]:py-1';
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pe-0',
        arabicTrim,
        className,
      )}
      {...props}
    />
  );
}

/** Caption that names the table for screen readers. */
function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
