import type { StockReceiptDetail } from '@ssdashboard/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewSkuDialog } from '@/catalog/new-sku-dialog';
import { NewLocationDialog } from './new-location-dialog';
import { renderWithQuery } from './render-with-query';
import { VoidReceiptDialog } from './void-receipt-dialog';

vi.mock('@/shell/current-location-provider', () => ({
  useLocationSwitcher: () => ({ retry: vi.fn(), ready: true, locations: [] }),
}));

const receipt = { id: 'r', number: 'SR-000001' } as StockReceiptDetail;
const onClose = vi.fn();

describe('stock dialogs name their close controls once each (AC-16)', () => {
  it.each([
    ['New SKU', <NewSkuDialog key="a" onClose={onClose} />],
    ['New location', <NewLocationDialog key="b" onClose={onClose} />],
    ['Void receipt', <VoidReceiptDialog key="c" receipt={receipt} onClose={onClose} />],
  ])('%s has one Cancel and one Close', async (_name, dialog) => {
    renderWithQuery(dialog);
    await screen.findByRole('dialog');
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  });
});
