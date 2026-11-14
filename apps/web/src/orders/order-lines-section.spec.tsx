import type { OrderLineView } from '@ssdashboard/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrderLinesSection } from './order-lines-section';

const reader = vi.hoisted(() => ({ language: 'en' }));
vi.mock('@/i18n/language-provider', () => ({
  useLanguage: () => ({
    language: reader.language,
    info: { intl: reader.language === 'ar' ? 'ar-EG' : 'en-US', hour12: true },
    config: undefined,
    configStatus: 'loading',
  }),
}));

const line = (overrides: Partial<OrderLineView> = {}): OrderLineView => ({
  id: '40000000-0000-4000-8000-000000000001',
  position: 1,
  variantId: '50000000-0000-4000-8000-000000000001',
  skuCode: 'TEE-RED-M',
  title: 'Stored title',
  name: { en: 'Red tee', ar: 'تيشيرت أحمر' },
  quantity: 1,
  unitPrice: '250.00',
  discountAmount: '0.00',
  grossAmount: '250.00',
  prepaidAmount: '0.00',
  creditAppliedAmount: '0.00',
  lineState: 'open',
  cancelReasonCode: null,
  shortQuantity: 0,
  ...overrides,
});

describe('OrderLinesSection line names (AC-5)', () => {
  it('shows the catalog name in the reader language, isolated for its direction', () => {
    reader.language = 'ar';
    render(<OrderLinesSection lines={[line()]} />);
    const name = screen.getByText('تيشيرت أحمر');
    expect(name.tagName).toBe('BDI');
    expect(name).toHaveAttribute('dir', 'auto');
    expect(screen.queryByText('Stored title')).toBeNull();
  });

  it('shows the English catalog name in English', () => {
    reader.language = 'en';
    render(<OrderLinesSection lines={[line()]} />);
    expect(screen.getByText('Red tee')).toBeVisible();
  });

  it('falls back to the stored title when the name is null or lacks the reader language', () => {
    reader.language = 'ar';
    render(
      <OrderLinesSection
        lines={[
          line({ name: null, id: '40000000-0000-4000-8000-000000000002' }),
          line({ name: { en: 'Only English' }, title: 'Second title' }),
        ]}
      />,
    );
    expect(screen.getByText('Stored title')).toBeVisible();
    expect(screen.getByText('Second title')).toBeVisible();
    expect(screen.queryByText('Only English')).toBeNull();
  });
});

describe('OrderLinesSection short mark (AC-5, AC-13)', () => {
  it('marks only a short line, with the missing quantity', () => {
    reader.language = 'en';
    render(
      <OrderLinesSection
        lines={[
          line({ quantity: 3, shortQuantity: 2 }),
          line({ id: '40000000-0000-4000-8000-000000000002', skuCode: 'TEE-BLUE-M' }),
        ]}
      />,
    );
    const rows = screen.getAllByRole('row');
    const shortRow = rows.find((row) => row.textContent?.includes('TEE-RED-M'));
    const fullRow = rows.find((row) => row.textContent?.includes('TEE-BLUE-M'));
    expect(shortRow).toHaveTextContent('Short by 2');
    expect(fullRow).not.toHaveTextContent('Short by');
  });
});
