import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReceiptFormPage } from './receipt-form-page';
import { renderWithQuery } from '@/shared/render-with-query';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: {
      id: 'a',
      hats: ['manager'],
      permissions: [
        'catalog.manage',
        'stock.view',
        'stock.receive',
        'cost.view',
        'people.manage',
        'stock.correct',
      ],
    },
  }),
}));
vi.mock('@/shell/current-location-provider', () => ({
  useCurrentLocation: () => 'all',
  useLocationSwitcher: () => ({ retry: vi.fn(), ready: true, status: 'ready', locations: [] }),
  locationName: () => '',
}));

// Spec 0004 AC-18: the form applies the same digit rules as the api.
describe('ReceiptFormPage digits (AC-18)', () => {
  it('shows the right line total for Arabic digits and separators', async () => {
    renderWithQuery(<ReceiptFormPage />);

    await userEvent.type(screen.getByLabelText('Quantity'), '٣');
    await userEvent.type(screen.getByLabelText('Unit cost'), '١٢٫٥٠');

    // 3 x 12.50 = 37.50, in Western digits. The line total is the only text that shows it.
    expect(await screen.findAllByText(/^37\.5(0|000)?$/)).not.toHaveLength(0);
    expect(screen.getByLabelText('Quantity')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByLabelText('Unit cost')).toHaveAttribute('inputmode', 'decimal');
  });

  it('shows the field error for a decimal comma and for a decimal quantity', async () => {
    renderWithQuery(<ReceiptFormPage />);

    await userEvent.type(screen.getByLabelText('Unit cost'), '1,5');
    await userEvent.tab();
    await userEvent.type(screen.getByLabelText('Quantity'), '1.5');
    await userEvent.tab();

    expect(await screen.findByText('Enter 0 or more with at most 4 decimals.')).toBeVisible();
    expect(screen.getByLabelText('Quantity')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Unit cost')).toHaveAttribute('aria-invalid', 'true');
  });
});
