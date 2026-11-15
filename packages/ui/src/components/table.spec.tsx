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

  describe('Arabic padding trim', () => {
    function cellWith(className?: string) {
      render(
        <Table aria-label="SKUs">
          <TableBody>
            <TableRow>
              <TableCell className={className}>x</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );
      return screen.getByRole('cell');
    }

    it('trims to 4px top and bottom when the caller sets no className', () => {
      expect(cellWith()).toHaveClass('p-2', '[&:lang(ar)]:py-1');
    });

    it('keeps the trim when the caller only sets horizontal padding', () => {
      expect(cellWith('px-3')).toHaveClass('[&:lang(ar)]:py-1');
    });

    it('drops the trim when the caller sets its own vertical padding', () => {
      expect(cellWith('px-3 py-10')).not.toHaveClass('[&:lang(ar)]:py-1');
    });

    it('drops the trim for a variant prefixed vertical padding', () => {
      expect(cellWith('sm:py-0')).not.toHaveClass('[&:lang(ar)]:py-1');
    });

    it('drops the trim when the caller sets its own Arabic padding', () => {
      expect(cellWith('px-3 py-0 [&:lang(ar)]:py-0')).not.toHaveClass('[&:lang(ar)]:py-1');
    });
  });
});
