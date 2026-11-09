import type { CustomerProfile } from '@ssdashboard/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { CustomerDetailPage } from './customer-detail-page';

const api = vi.hoisted(() => ({
  getCustomer: vi.fn(),
  setCustomerFlag: vi.fn(),
  clearCustomerFlag: vi.fn(),
}));
vi.mock('./customers-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000001';
vi.mock('next/navigation', () => ({ useParams: () => ({ id: CUSTOMER_ID }) }));

const me = vi.hoisted(() => ({
  current: { id: 'me', hats: ['support'], permissions: ['customers.view', 'customers.flag'] },
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({ status: 'ready', me: me.current }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const profile = (flagged: boolean): CustomerProfile => ({
  id: CUSTOMER_ID,
  resolvedFrom: null,
  name: 'Mona Adel',
  phones: [],
  channelIds: [],
  merges: [],
  flag: flagged
    ? {
        kind: 'refuser',
        source: 'manual',
        note: 'x',
        setAt: '2026-11-03T10:00:00.000Z',
        setByName: null,
      }
    : null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  me.current = { id: 'me', hats: ['support'], permissions: ['customers.view', 'customers.flag'] };
});

describe('flag actions on the profile (AC-11)', () => {
  it('leaves the buttons out without customers.flag', async () => {
    me.current = { id: 'me', hats: ['viewer'], permissions: ['customers.view'] };
    api.getCustomer.mockResolvedValue(profile(true));
    renderWithQuery(<CustomerDetailPage />);
    await screen.findByRole('heading', { level: 1, name: 'Mona Adel' });
    expect(screen.queryByRole('button', { name: 'Change flag' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear flag' })).toBeNull();
  });

  it('asks for a kind before sending', async () => {
    api.getCustomer.mockResolvedValue(profile(false));
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Flag customer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save flag' }));
    expect(await screen.findByText('Choose a kind of flag.')).toBeVisible();
    expect(api.setCustomerFlag).not.toHaveBeenCalled();
  });

  it('sends the profile updatedAt, and keeps the dialog and note on STALE_RECORD', async () => {
    api.getCustomer.mockResolvedValue(profile(false));
    api.setCustomerFlag.mockRejectedValue(new ApiError(409, { code: 'STALE_RECORD' }));
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Flag customer' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Fake orders' }));
    await userEvent.type(screen.getByLabelText('Note'), 'secret note');
    await userEvent.click(screen.getByRole('button', { name: 'Save flag' }));

    expect(api.setCustomerFlag).toHaveBeenCalledWith(CUSTOMER_ID, {
      kind: 'fake',
      note: 'secret note',
      expectedUpdatedAt: '2026-11-03T10:00:00.000Z',
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This customer changed while you were looking');
    expect(alert).not.toHaveTextContent('secret note');
    expect(screen.getByLabelText('Note')).toHaveValue('secret note');
  });

  it('requires a reason to clear', async () => {
    api.getCustomer.mockResolvedValue(profile(true));
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Clear flag' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear flag', hidden: false }));
    expect(await screen.findByText('Choose a reason.')).toBeVisible();
    expect(api.clearCustomerFlag).not.toHaveBeenCalled();
  });
});
