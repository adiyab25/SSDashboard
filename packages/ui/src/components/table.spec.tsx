import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

describe('Table', () => {
  it('wraps the table in a focusable, named scroll region', () => {
    render(
      <Table aria-label="SKUs">
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const region = screen.getByRole('region', { name: 'SKUs' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table', { name: 'SKUs' }));
  });

  it('reuses aria-labelledby for the region name', () => {
    render(
      <>
        <h2 id="t">Stock</h2>
        <Table aria-labelledby="t" />
      </>,
    );
    expect(screen.getByRole('region', { name: 'Stock' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Stock' })).toBeInTheDocument();
  });

  it('takes row and header heights from the density tokens', () => {
    render(
      <Table aria-label="SKUs">
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );

    expect(screen.getByRole('columnheader', { name: 'Code' })).toHaveClass('h-row-header');
    expect(screen.getByRole('row')).toHaveClass('h-row');
  });

  it('trims the cell padding to 4px top and bottom for Arabic so a row stays 40px', () => {
    render(
      <Table aria-label="SKUs">
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(screen.getByRole('cell')).toHaveClass('p-2', '[&:lang(ar)]:py-1');
  });
});
