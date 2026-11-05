import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReceiptFormPage } from './receipt-form-page';
import { renderWithQuery } from './render-with-query';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/auth/use-me', () => ({ useMe: () => ({ id: 'a', role: 'staff' }) }));
vi.mock('@/shell/current-location-provider', () => ({
  useCurrentLocation: () => 'all',
  useLocationSwitcher: () => ({ retry: vi.fn(), ready: true, status: 'ready', locations: [] }),
  locationName: () => '',
}));

describe('ReceiptFormPage focus (AC-16)', () => {
  it('focuses the new line SKU combobox after Add line', async () => {
    renderWithQuery(<ReceiptFormPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    const combos = screen.getAllByRole('combobox', { name: 'SKU' });
    expect(combos).toHaveLength(2);
    expect(combos[1]).toHaveFocus();
  });

  it('moves focus to the next line when a line is removed, never to the body', async () => {
    renderWithQuery(<ReceiptFormPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));
    expect(screen.getAllByRole('combobox', { name: 'SKU' })).toHaveLength(2);
    // The old line 2 is line 1 now, and its Remove button holds focus.
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toHaveFocus();
  });

  it('falls back to the previous line, then the SKU combobox, when the last line goes', async () => {
    renderWithQuery(<ReceiptFormPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    // One line is left and its Remove button is disabled, so focus lands on its SKU combobox.
    expect(screen.getAllByRole('combobox', { name: 'SKU' })[0]).toHaveFocus();
  });
});
