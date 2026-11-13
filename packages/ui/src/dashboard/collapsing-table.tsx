import type { ReactNode } from 'react';
import { cn } from 'cn';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';

type CollapsingColumn<Row> = {
  /** A stable key for the column. */
  id: string;
  /** The already translated column header; also the label in the card. */
  header: string;
  /** Draws the cell, usually a value, a `StatusChip`, or a link. The card shows the same node. */
  cell: (row: Row) => ReactNode;
  /** `end` for numbers and money (`text-end`, `tabular-nums`). */
  align?: 'start' | 'end';
  /** Marks the one column that becomes the card's title line (the first column by default). */
  title?: boolean;
};

type CollapsingTableProps<Row> = {
  /** The already translated name of the table and of the card list. */
  caption: string;
  columns: CollapsingColumn<Row>[];
  rows: Row[];
  /** A stable key per row, such as the order code. */
  getRowKey: (row: Row) => string;
  className?: string;
};

/**
 * A data table that becomes a list of cards below 640px (`sm`), with the same cells and the same
 * chips (AC-20). Both views come from the same columns; the table is `hidden` under `sm` and the
 * card list is `hidden` from `sm` up, and `display: none` removes the hidden one from the tab
 * order and the accessibility tree, so no control is reachable twice. The card's title is the
 * `title` column (else the first); every other column is a label and value pair. It never
 * scrolls sideways on a phone. It must never hold text of its own, sort or filter (the caller
 * passes ordered rows), or rely on hover.
 */
export function CollapsingTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  className,
}: CollapsingTableProps<Row>) {
  const titleColumn = columns.find((column) => column.title) ?? columns[0];
  const rest = columns.filter((column) => column !== titleColumn);
  return (
    <div data-slot="collapsing-table" className={className}>
      <div className="hidden sm:block">
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  key={column.id}
                  className={column.align === 'end' ? 'text-end' : undefined}
                >
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={getRowKey(row)}>
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(column.align === 'end' && 'text-end tabular-nums')}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul aria-label={caption} className="flex flex-col gap-2 sm:hidden">
        {rows.map((row) => (
          <li key={getRowKey(row)} className="gradient-card-edge rounded-card p-3 text-sm">
            {titleColumn ? <div className="font-medium">{titleColumn.cell(row)}</div> : null}
            <dl className="mt-2 flex flex-col gap-1.5">
              {rest.map((column) => (
                <div key={column.id} className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{column.header}</dt>
                  <dd className={cn('min-w-0 text-end', column.align === 'end' && 'tabular-nums')}>
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
