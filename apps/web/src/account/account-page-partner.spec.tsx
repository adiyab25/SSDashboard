import type { MeResponse } from '@ssdashboard/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPage } from './account-page';

const updateProfile = vi.hoisted(() => vi.fn());
vi.mock('@/auth/account-api', () => ({ updateProfile }));
vi.mock('@/auth/auth-client', () => ({ authClient: () => ({}) }));

const PARTNER: MeResponse = {
  id: '0190c0de-0000-7000-8000-000000000002',
  name: 'Mona Partner',
  email: 'mona@showroom.example',
  hats: ['support', 'operations', 'warehouse'],
  permissions: ['stock.view'],
  partnerAccountId: null,
  phone: null,
  staffCode: null,
  language: null,
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'partner',
};

const useMeState = vi.hoisted(() => vi.fn());
vi.mock('@/auth/use-me', () => ({ useMeState, setMe: () => undefined }));
vi.mock('@/shell/client-config', () => ({
  loadConfig: () => Promise.resolve({ languages: ['en', 'ar'], mailEnabled: false }),
}));

describe('AccountPage for a partner user (AC-28, AC-34)', () => {
  beforeEach(() => useMeState.mockReturnValue({ status: 'ready', me: PARTNER }));
  afterEach(() => {
    useMeState.mockReset();
    updateProfile.mockReset();
  });

  it('reads the person from /api/partner/me', async () => {
    render(<AccountPage audience="partner" />);

    await screen.findByLabelText(/^Name/);
    expect(useMeState).toHaveBeenCalledWith('/api/partner/me');
  });

  it('keeps the back office route for the default audience', async () => {
    render(<AccountPage />);

    await screen.findByLabelText(/^Name/);
    expect(useMeState).toHaveBeenCalledWith('/api/me');
  });

  it('has one heading and shows the email only, with no role or staff code and no staff wording', async () => {
    const { container } = render(<AccountPage audience="partner" />);

    await screen.findByLabelText(/^Name/);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('mona@showroom.example')).toBeVisible();
    expect(screen.queryByText('Role')).not.toBeInTheDocument();
    expect(screen.queryByText('Hats')).not.toBeInTheDocument();
    expect(screen.queryByText(/staff/i)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/staff|employee/i);
    expect(screen.getByText('An administrator changes your email.')).toBeVisible();
  });

  it('shows an inline error with no staff wording when /api/partner/me settles empty', async () => {
    useMeState.mockReturnValue({ status: 'failed' });
    const { container } = render(<AccountPage audience="partner" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Check your connection and try again.',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/staff|employee/i);
  });

  it('leaves the one h1 to the frame when drawn inFrame', async () => {
    render(<AccountPage audience="partner" inFrame />);

    await screen.findByLabelText(/^Name/);
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('saves through the partner audience', async () => {
    updateProfile.mockResolvedValue({ ok: true, me: PARTNER });
    render(<AccountPage audience="partner" />);
    const name = await screen.findByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Mona A');

    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(updateProfile).toHaveBeenCalledWith(
      { name: 'Mona A', phone: '', language: '' },
      'partner',
    );
  });
});
