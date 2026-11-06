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
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
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
        'h-row border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
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
        'h-row-header px-2 text-start align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pe-0',
        className,
      )}
      {...props}
    />
  );
}

/** Data cell. */
function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pe-0', className)}
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
