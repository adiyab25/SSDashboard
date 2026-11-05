import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { ReceiptDetailPage } from './receipt-detail-page';
import { renderWithQuery } from './render-with-query';

const api = vi.hoisted(() => ({ getReceipt: vi.fn() }));
vi.mock('./inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'r1' }) }));
vi.mock('@/auth/use-me', () => ({ useMe: () => ({ id: 'a', role: 'staff' }) }));

afterEach(() => api.getReceipt.mockReset());

describe('ReceiptDetailPage headings (AC-16)', () => {
  it('has the page h1 while loading', () => {
    api.getReceipt.mockReturnValue(new Promise(() => undefined));
    renderWithQuery(<ReceiptDetailPage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Stock receipt' })).toBeVisible();
  });

  it('names the page, not "Lines", in the not found state', async () => {
    api.getReceipt.mockRejectedValue(
      new ApiError(404, { code: 'NOT_FOUND', message: 'x' } as never),
    );
    renderWithQuery(<ReceiptDetailPage />);
    expect(await screen.findByText('There is no such receipt.')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Stock receipt' })).toBeVisible();
  });

  it('keeps one named h1 on a load error', async () => {
    api.getReceipt.mockRejectedValue(new Error('boom'));
    renderWithQuery(<ReceiptDetailPage />);
    expect(await screen.findByText('The receipt could not be loaded.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Stock receipt' })).toBeVisible();
  });
});
