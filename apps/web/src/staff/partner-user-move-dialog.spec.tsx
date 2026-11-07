import type { PartnerAccount, PartnerUserDetail } from '@ssdashboard/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartnerUserMoveDialog } from './partner-user-move-dialog';

const api = vi.hoisted(() => ({ getPartnerUser: vi.fn(), movePartnerUser: vi.fn() }));
vi.mock('./partner-users-api', () => api);

const NILE = '0190c0de-0000-7000-8000-00000000a001';
const DELTA = '0190c0de-0000-7000-8000-00000000a002';
const ACCOUNTS: PartnerAccount[] = [
  { id: NILE, code: 'NILE', name: 'Nile Showroom' },
  { id: DELTA, code: 'DELTA', name: 'Delta Boutique' },
];
const UPDATED_AT = '2026-11-05T10:00:00.123456Z';

const detail = (): PartnerUserDetail => ({
  id: 'ola-id',
  name: 'Ola Partner',
  email: 'ola@example.com',
  partnerAccountId: NILE,
  status: 'active',
  lastSignInAt: null,
  twoFactorEnabled: false,
  phone: null,
  language: null,
  disableReason: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: UPDATED_AT,
});

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const fail = (code: string, status = 409) => Promise.resolve({ ok: false as const, status, code });

function renderDialog(onSaved = vi.fn(), onClose = vi.fn()) {
  render(
    <PartnerUserMoveDialog
      partnerUserId="ola-id"
      name="Ola Partner"
      accounts={ACCOUNTS}
      opener={null}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
}

async function show() {
  api.getPartnerUser.mockImplementation(() => ok(detail()));
  const onSaved = vi.fn();
  renderDialog(onSaved);
  const select = await screen.findByLabelText(/^New partner account/);
  return { onSaved, select };
}

const save = () => userEvent.click(screen.getByRole('button', { name: 'Move login' }));

describe('PartnerUserMoveDialog (spec 0008, AC-12, AC-15)', () => {
  afterEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  it('starts on the account choice, names where the person is now, and offers only other accounts', async () => {
    const { select } = await show();

    await waitFor(() => expect(select).toHaveFocus());
    expect(screen.getByText('Now in Nile Showroom')).toBeVisible();
    expect(screen.getByRole('option', { name: 'Delta Boutique (DELTA)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Nile Showroom (NILE)' })).not.toBeInTheDocument();
    expect(screen.getByText(/signed out everywhere/)).toBeVisible();
  });

  it('asks for an account before it sends anything', async () => {
    const { select } = await show();

    await save();

    expect(
      await screen.findByText('Choose the partner account this login belongs to.'),
    ).toBeVisible();
    expect(select).toHaveFocus();
    expect(api.movePartnerUser).not.toHaveBeenCalled();
  });

  it('sends the new account, the reason and the updatedAt read when it opened', async () => {
    const { onSaved, select } = await show();
    const saved = { ...detail(), partnerAccountId: DELTA };
    api.movePartnerUser.mockImplementation(() => ok(saved));

    await userEvent.selectOptions(select, DELTA);
    await save();

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(api.movePartnerUser).toHaveBeenCalledWith('ola-id', {
      partnerAccountId: DELTA,
      updatedAt: UPDATED_AT,
    });
  });

  it('says a stale record in plain words and reloads what the login holds now', async () => {
    const { select } = await show();
    api.movePartnerUser.mockImplementation(() => fail('STALE_RECORD'));

    await userEvent.selectOptions(select, DELTA);
    await save();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Someone else changed this login/);
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.getPartnerUser).toHaveBeenCalledTimes(2));
  });

  it('says an account that no longer exists in plain words', async () => {
    const { select } = await show();
    api.movePartnerUser.mockImplementation(() => fail('UNKNOWN_PARTNER_ACCOUNT', 422));

    await userEvent.selectOptions(select, DELTA);
    await save();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That partner account no longer exists. Choose another one.',
    );
  });

  it('shows a load error with a reload when the login cannot be read', async () => {
    api.getPartnerUser.mockImplementation(() => fail('generic', 500));
    renderDialog();

    expect(await screen.findByText('This login could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move login' })).toBeDisabled();
  });
});
