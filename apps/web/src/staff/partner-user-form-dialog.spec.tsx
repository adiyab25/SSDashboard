import type { PartnerAccount, PartnerUserDetail } from '@ssdashboard/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartnerUserFormDialog } from './partner-user-form-dialog';

const api = vi.hoisted(() => ({
  getPartnerUser: vi.fn(),
  createPartnerUser: vi.fn(),
  updatePartnerUser: vi.fn(),
}));
vi.mock('./partner-users-api', () => api);

const NILE = '0190c0de-0000-7000-8000-00000000a001';
const ACCOUNTS: PartnerAccount[] = [{ id: NILE, code: 'NILE', name: 'Nile Showroom' }];

const detail = (overrides: Partial<PartnerUserDetail> = {}): PartnerUserDetail => ({
  id: 'ola-id',
  name: 'Ola Partner',
  email: 'ola@example.com',
  partnerAccountId: NILE,
  status: 'active',
  lastSignInAt: null,
  twoFactorEnabled: false,
  phone: '+20 100 123 4567',
  language: 'ar',
  disableReason: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.123456Z',
  ...overrides,
});

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const fail = (code: string, status = 409) => Promise.resolve({ ok: false as const, status, code });

function show(editId: string | null, accounts = ACCOUNTS) {
  const onSaved = vi.fn();
  render(
    <PartnerUserFormDialog
      editId={editId}
      accounts={accounts}
      languages={['en', 'ar']}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  );
  return { onSaved };
}

describe('PartnerUserFormDialog (spec 0008, AC-15)', () => {
  afterEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  it('adds with no hats and no cost switch, and sends only what was filled in', async () => {
    api.createPartnerUser.mockImplementation(() =>
      ok({ partnerUser: detail(), setup: { mode: 'email' } }),
    );
    const { onSaved } = show(null);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Name/), 'Ola Partner');
    await userEvent.type(screen.getByLabelText(/^Email/), 'ola@example.com');
    await userEvent.selectOptions(screen.getByLabelText(/^Partner account/), NILE);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.createPartnerUser).toHaveBeenCalledWith({
      name: 'Ola Partner',
      email: 'ola@example.com',
      partnerAccountId: NILE,
    });
  });

  it('names every problem and focuses the first', async () => {
    show(null);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter a name.')).toBeVisible();
    expect(screen.getByLabelText(/^Name/)).toHaveFocus();
    expect(screen.getByText('Enter an email address.')).toBeVisible();
    expect(screen.getByText('Choose the partner account this login belongs to.')).toBeVisible();
    expect(api.createPartnerUser).not.toHaveBeenCalled();
  });

  it('puts a taken email on the email field and an unknown account on the account field', async () => {
    show(null);
    await userEvent.type(screen.getByLabelText(/^Name/), 'Ola Partner');
    await userEvent.type(screen.getByLabelText(/^Email/), 'ola@example.com');
    await userEvent.selectOptions(screen.getByLabelText(/^Partner account/), NILE);

    api.createPartnerUser.mockImplementationOnce(() => fail('EMAIL_TAKEN'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Another account already uses this email.')).toBeVisible();
    expect(screen.getByLabelText(/^Email/)).toHaveFocus();

    api.createPartnerUser.mockImplementationOnce(() => fail('UNKNOWN_PARTNER_ACCOUNT', 422));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('That partner account no longer exists. Choose another one.'),
    ).toBeVisible();
    expect(screen.getByLabelText(/^Partner account/)).toHaveFocus();
  });

  it('says there are no partner accounts when the picker is empty', () => {
    show(null, []);

    expect(screen.getByText('There are no partner accounts yet.')).toBeVisible();
  });

  it('edits details only: the account is read only and never sent, the email is locked after sign in', async () => {
    api.getPartnerUser.mockImplementation(() => ok(detail()));
    api.updatePartnerUser.mockImplementation(() => ok(detail({ name: 'Ola P.' })));
    const { onSaved } = show('ola-id');

    const name = await screen.findByLabelText(/^Name/);
    await waitFor(() => expect(name).toHaveValue('Ola Partner'));
    expect(screen.getByLabelText(/^Email/)).toBeDisabled();
    expect(screen.getByLabelText(/^Partner account/)).toHaveValue('Nile Showroom');
    expect(screen.getByLabelText(/^Partner account/)).toHaveAttribute('readonly');
    await userEvent.clear(name);
    await userEvent.type(name, 'Ola P.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updatePartnerUser).toHaveBeenCalledWith('ola-id', {
      name: 'Ola P.',
      phone: '+20 100 123 4567',
      language: 'ar',
    });
  });

  it('lets an invited login change its email, and reports that it changed', async () => {
    api.getPartnerUser.mockImplementation(() => ok(detail({ status: 'invited' })));
    api.updatePartnerUser.mockImplementation(() => ok(detail({ status: 'invited' })));
    const { onSaved } = show('ola-id');

    const email = await screen.findByLabelText(/^Email/);
    await waitFor(() => expect(email).toHaveValue('ola@example.com'));
    await userEvent.clear(email);
    await userEvent.type(email, 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ emailChanged: true })),
    );
    expect(api.updatePartnerUser).toHaveBeenCalledWith(
      'ola-id',
      expect.objectContaining({ email: 'new@example.com' }),
    );
  });

  it('says so, shuts the fields and Save, and reloads when the login cannot be loaded (review r8)', async () => {
    api.getPartnerUser.mockImplementationOnce(() => fail('NOT_FOUND', 404));
    api.getPartnerUser.mockImplementation(() => ok(detail()));
    show('ola-id');

    expect(await screen.findByText('This login could not be loaded.')).toBeVisible();
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
    expect(screen.getByLabelText('Phone')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('Ola Partner'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('names an unknown partner account in the read only field (review r9)', async () => {
    api.getPartnerUser.mockImplementation(() => ok(detail()));
    show('ola-id', []);

    await waitFor(() =>
      expect(screen.getByLabelText(/^Partner account/)).toHaveValue('Unknown partner account'),
    );
  });
});
