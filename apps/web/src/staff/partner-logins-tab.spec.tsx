import type { PartnerAccount, PartnerUserRow } from '@ssdashboard/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartnerLoginsTab } from './partner-logins-tab';

const api = vi.hoisted(() => ({
  listPartnerUsers: vi.fn(),
  listPartnerAccounts: vi.fn(),
  getPartnerUser: vi.fn(),
  createPartnerUser: vi.fn(),
  updatePartnerUser: vi.fn(),
  movePartnerUser: vi.fn(),
  disablePartnerUser: vi.fn(),
  enablePartnerUser: vi.fn(),
  resetPartnerUserPassword: vi.fn(),
  resendPartnerInvite: vi.fn(),
  resetPartnerUserTwoFactor: vi.fn(),
  revokePartnerUserSessions: vi.fn(),
}));
vi.mock('./partner-users-api', () => api);

const NILE = '0190c0de-0000-7000-8000-00000000a001';
const DELTA = '0190c0de-0000-7000-8000-00000000a002';
const ACCOUNTS: PartnerAccount[] = [
  { id: NILE, code: 'NILE', name: 'Nile Showroom' },
  { id: DELTA, code: 'DELTA', name: 'Delta Boutique' },
];

const row = (
  overrides: Partial<PartnerUserRow> & { id: string; name: string },
): PartnerUserRow => ({
  email: `${overrides.id}@example.com`,
  partnerAccountId: NILE,
  status: 'active',
  lastSignInAt: '2026-11-02T09:30:00.000Z',
  twoFactorEnabled: false,
  ...overrides,
});

const ROWS = [
  row({ id: 'ola-id', name: 'Ola Partner' }),
  row({ id: 'new-id', name: 'Nour Newlogin', status: 'invited', lastSignInAt: null }),
  row({
    id: 'gone-id',
    name: 'Gil Gone',
    status: 'disabled',
    twoFactorEnabled: true,
    partnerAccountId: DELTA,
  }),
];

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const fail = (code: string, status = 409) => Promise.resolve({ ok: false as const, status, code });
const page = (rows: PartnerUserRow[], nextCursor: string | null = null) => ok({ rows, nextCursor });

async function openMenu(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
}

describe('PartnerLoginsTab (spec 0008, AC-15, AC-18)', () => {
  beforeEach(() => {
    api.listPartnerAccounts.mockImplementation(() => ok(ACCOUNTS));
    api.listPartnerUsers.mockImplementation(() => page(ROWS));
  });
  afterEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  it('lists partner logins with their partner account, status, last sign in and two factor', async () => {
    render(<PartnerLoginsTab mailEnabled languages={['en', 'ar']} />);

    const table = await screen.findByRole('table');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Partner account' })).toBeVisible();
    expect(within(table).queryByRole('columnheader', { name: 'Hats' })).not.toBeInTheDocument();
    expect(
      within(table).queryByRole('columnheader', { name: 'Sees cost' }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(table).getByRole('row', { name: /Ola Partner/ })).toHaveTextContent(
        'Nile Showroom',
      ),
    );
    expect(within(table).getByRole('row', { name: /Nour Newlogin/ })).toHaveTextContent('Invited');
    expect(within(table).getByRole('row', { name: /Nour Newlogin/ })).toHaveTextContent('Never');
    const gone = within(table).getByRole('row', { name: /Gil Gone/ });
    expect(gone).toHaveTextContent('Delta Boutique');
    expect(gone).toHaveTextContent('Disabled');
    expect(gone).toHaveTextContent('On');
  });

  it('searches after a short pause and filters by partner account and status, from the first page', async () => {
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);
    await screen.findByRole('table');

    await userEvent.type(screen.getByLabelText('Search partner logins'), 'ola');
    await waitFor(() =>
      expect(api.listPartnerUsers).toHaveBeenLastCalledWith({
        q: 'ola',
        status: '',
        partnerAccountId: '',
      }),
    );
    expect(api.listPartnerUsers).not.toHaveBeenCalledWith({
      q: 'o',
      status: '',
      partnerAccountId: '',
    });

    await userEvent.selectOptions(screen.getByLabelText('Partner account'), DELTA);
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'disabled');
    await waitFor(() =>
      expect(api.listPartnerUsers).toHaveBeenLastCalledWith({
        q: 'ola',
        status: 'disabled',
        partnerAccountId: DELTA,
      }),
    );
  });

  it('shows an empty state, and an error with a retry', async () => {
    api.listPartnerUsers.mockImplementationOnce(() => fail('generic', 500));
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    expect(await screen.findByText('The partner logins could not be loaded.')).toBeVisible();
    api.listPartnerUsers.mockImplementationOnce(() => page([]));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No partner logins match/)).toBeVisible();
  });

  it('says so, with a retry, when the partner accounts could not be loaded', async () => {
    api.listPartnerAccounts.mockImplementationOnce(() => fail('generic', 500));
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    expect(await screen.findByText('The partner accounts could not be loaded.')).toBeVisible();
  });

  it('names an unknown partner account instead of leaving the cell empty (review r9)', async () => {
    api.listPartnerAccounts.mockImplementation(() => fail('generic', 500));
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    const table = await screen.findByRole('table');
    await waitFor(() =>
      expect(within(table).getByRole('row', { name: /Ola Partner/ })).toHaveTextContent(
        'Unknown partner account',
      ),
    );
  });

  it('loads the next page with its cursor and adds the rows', async () => {
    api.listPartnerUsers
      .mockImplementationOnce(() => page([ROWS[0] as PartnerUserRow], 'cursor-1'))
      .mockImplementationOnce(() => page([ROWS[1] as PartnerUserRow]));
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Nour Newlogin')).toBeVisible();
    expect(api.listPartnerUsers).toHaveBeenLastCalledWith(
      { q: '', status: '', partnerAccountId: '' },
      'cursor-1',
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('adds a partner login bound to the picked account and shows the temporary password once', async () => {
    api.createPartnerUser.mockImplementation(() =>
      ok({
        partnerUser: { ...row({ id: 'p-id', name: 'Pia Partner' }), phone: null, language: null },
        setup: { mode: 'temporary_password', temporaryPassword: 'Temp-Pass-123' },
      }),
    );
    render(<PartnerLoginsTab mailEnabled={false} languages={['en', 'ar']} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Add partner login' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add partner login' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Choose the partner account this login belongs to.'),
    ).toBeVisible();
    expect(api.createPartnerUser).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Pia Partner');
    await userEvent.type(within(dialog).getByLabelText(/^Email/), 'pia@example.com');
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Partner account/), DELTA);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.createPartnerUser).toHaveBeenCalledWith({
        name: 'Pia Partner',
        email: 'pia@example.com',
        partnerAccountId: DELTA,
      }),
    );
    expect(await screen.findByText('Temporary password for Pia Partner')).toBeVisible();
    expect(screen.getByText('Temp-Pass-123')).toBeVisible();
    await waitFor(() => expect(api.listPartnerUsers.mock.calls.length).toBeGreaterThan(1));
  });

  it('offers the actions that fit each row, and no hats or self actions', async () => {
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    await openMenu('Ola Partner');
    let menu = await screen.findByRole('menu');
    for (const name of [
      'Edit',
      'Move to another account',
      'Reset password',
      'Sign out everywhere',
      'Disable',
    ]) {
      expect(within(menu).getByRole('menuitem', { name })).toBeVisible();
    }
    expect(within(menu).queryByRole('menuitem', { name: 'Resend invite' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Edit hats' })).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Reset two factor' }),
    ).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await openMenu('Nour Newlogin');
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Resend invite' })).toBeVisible();
    await userEvent.keyboard('{Escape}');

    await openMenu('Gil Gone');
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Enable' })).toBeVisible();
    expect(within(menu).getByRole('menuitem', { name: 'Reset two factor' })).toBeVisible();
    expect(within(menu).queryByRole('menuitem', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('hides Resend invite when the install sends no email', async () => {
    render(<PartnerLoginsTab mailEnabled={false} languages={['en']} />);

    await openMenu('Nour Newlogin');
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Resend invite' })).not.toBeInTheDocument();
  });

  it('disables a login with a reason after confirming', async () => {
    api.disablePartnerUser.mockImplementation(() => ok({}));
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    await openMenu('Ola Partner');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable Ola Partner?' });
    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'Left the showroom');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable account' }));

    await waitFor(() =>
      expect(api.disablePartnerUser).toHaveBeenCalledWith('ola-id', 'Left the showroom'),
    );
    expect(await screen.findByText('Account disabled.')).toBeVisible();
  });

  it('enables, re-invites, resets two factor and signs out everywhere', async () => {
    api.enablePartnerUser.mockImplementation(() => ok({}));
    api.resendPartnerInvite.mockImplementation(() => ok({ ok: true }));
    api.resetPartnerUserTwoFactor.mockImplementation(() => ok({}));
    api.revokePartnerUserSessions.mockImplementation(() => ok({ revoked: 2 }));
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    await openMenu('Gil Gone');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Enable' }));
    await waitFor(() => expect(api.enablePartnerUser).toHaveBeenCalledWith('gone-id'));
    expect(await screen.findByText('Account enabled.')).toBeVisible();

    await openMenu('Nour Newlogin');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Resend invite' }));
    await waitFor(() => expect(api.resendPartnerInvite).toHaveBeenCalledWith('new-id'));
    expect(await screen.findByText('Invite sent again.')).toBeVisible();

    await openMenu('Gil Gone');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reset two factor' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reset two factor' }));
    await waitFor(() => expect(api.resetPartnerUserTwoFactor).toHaveBeenCalledWith('gone-id'));

    await openMenu('Ola Partner');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out everywhere' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(api.revokePartnerUserSessions).toHaveBeenCalledWith('ola-id'));
  });

  it('resets a password: a mail login says an email went out, otherwise a temporary password shows', async () => {
    api.resetPartnerUserPassword.mockImplementation(() =>
      ok({ setup: { mode: 'temporary_password', temporaryPassword: 'Fresh-Pass-9' } }),
    );
    render(<PartnerLoginsTab mailEnabled={false} languages={['en']} />);

    await openMenu('Ola Partner');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reset password' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Fresh-Pass-9')).toBeVisible();
  });

  it('says a refusal in plain words inside the confirm dialog', async () => {
    api.revokePartnerUserSessions.mockImplementation(() => fail('NOT_FOUND', 404));
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    await openMenu('Ola Partner');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out everywhere' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));

    expect(await screen.findByText('That partner login no longer exists.')).toBeVisible();
  });

  it('moves a login to another partner account with a reason, from the row menu', async () => {
    const detail = {
      ...row({ id: 'ola-id', name: 'Ola Partner' }),
      phone: null,
      language: null,
      disableReason: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-11-05T10:00:00.123456Z',
    };
    api.getPartnerUser.mockImplementation(() => ok(detail));
    api.movePartnerUser.mockImplementation(() => ok({ ...detail, partnerAccountId: DELTA }));
    render(<PartnerLoginsTab mailEnabled languages={['en']} />);

    await openMenu('Ola Partner');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to another account' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Move Ola Partner to another partner account',
    });
    const select = await within(dialog).findByLabelText(/^New partner account/);
    await waitFor(() => expect(select).toHaveFocus());
    await userEvent.selectOptions(select, DELTA);
    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'Moved shops');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move login' }));

    await waitFor(() =>
      expect(api.movePartnerUser).toHaveBeenCalledWith('ola-id', {
        partnerAccountId: DELTA,
        updatedAt: '2026-11-05T10:00:00.123456Z',
        reason: 'Moved shops',
      }),
    );
    expect(
      await screen.findByText('Partner login moved. They were signed out everywhere.'),
    ).toBeVisible();
    await waitFor(() => expect(api.listPartnerUsers.mock.calls.length).toBeGreaterThan(1));
  });
});
