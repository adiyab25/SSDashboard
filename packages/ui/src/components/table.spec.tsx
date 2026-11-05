import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Table, TableBody, TableCell, TableRow } from './table';

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
});
