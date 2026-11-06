import type { StaffRow } from '@ssdashboard/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaffPage } from './staff-page';

const api = vi.hoisted(() => ({
  listStaff: vi.fn(),
  getStaff: vi.fn(),
  createStaff: vi.fn(),
  updateStaff: vi.fn(),
  disableStaff: vi.fn(),
  enableStaff: vi.fn(),
  resetStaffPassword: vi.fn(),
  resendInvite: vi.fn(),
  revokeStaffSessions: vi.fn(),
  resetStaffTwoFactor: vi.fn(),
}));
vi.mock('./staff-api', () => api);

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: {
      id: 'me-id',
      hats: ['manager'],
      permissions: ['catalog.manage', 'cost.view', 'people.manage', 'stock.correct'],
    },
  }),
);
vi.mock('@/auth/use-me', () => ({ useMe: () => me.current }));

const loadConfig = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('@/shell/client-config', () => ({ loadConfig: () => loadConfig() }));

const row = (overrides: Partial<StaffRow> & { id: string; name: string }): StaffRow => ({
  email: `${overrides.id}@example.com`,
  role: 'staff',
  status: 'active',
  lastSignInAt: '2026-11-02T09:30:00.000Z',
  twoFactorEnabled: false,
  ...overrides,
});

const ROWS = [
  row({ id: 'me-id', name: 'Amira Admin', role: 'admin' }),
  row({ id: 'sam-id', name: 'Sam Carter' }),
  row({ id: 'new-id', name: 'Nour Newhire', status: 'invited', lastSignInAt: null }),
  row({ id: 'gone-id', name: 'Gil Gone', status: 'disabled', twoFactorEnabled: true }),
];

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const fail = (code: string, status = 409) => Promise.resolve({ ok: false as const, status, code });
const page = (rows: StaffRow[], nextCursor: string | null = null) => ok({ rows, nextCursor });

async function openMenu(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
}

describe('StaffPage (AC-12 to AC-18, AC-25)', () => {
  beforeEach(() => {
    me.current = {
      id: 'me-id',
      hats: ['manager'],
      permissions: ['catalog.manage', 'cost.view', 'people.manage', 'stock.correct'],
    };
    loadConfig.mockResolvedValue({ mailEnabled: true, languages: ['en', 'ar'] });
    api.listStaff.mockImplementation(() => page(ROWS));
  });
  afterEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    loadConfig.mockReset();
  });

  it('lists staff with their role, derived status, last sign in and two factor', async () => {
    render(<StaffPage />);

    const table = await screen.findByRole('table');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const sam = within(table).getByRole('row', { name: /Sam Carter/ });
    expect(sam).toHaveTextContent('sam-id@example.com');
    expect(sam).toHaveTextContent('Staff');
    expect(sam).toHaveTextContent('Active');
    expect(within(table).getByRole('row', { name: /Nour Newhire/ })).toHaveTextContent('Invited');
    expect(within(table).getByRole('row', { name: /Nour Newhire/ })).toHaveTextContent('Never');
    expect(within(table).getByRole('row', { name: /Gil Gone/ })).toHaveTextContent('Disabled');
    expect(within(table).getByRole('row', { name: /Gil Gone/ })).toHaveTextContent('On');
    expect(within(table).getByRole('row', { name: /Amira Admin/ })).toHaveTextContent(
      'Administrator',
    );
  });

  it('shows the no access state, and asks the api for no staff, without people.manage (spec 0008, AC-11)', async () => {
    me.current = { id: 'x', hats: ['warehouse'], permissions: ['stock.view'] };
    render(<StaffPage />);

    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Staff');
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(api.listStaff).not.toHaveBeenCalled();
  });

  it('shows an empty state, and an error with a retry', async () => {
    api.listStaff.mockImplementationOnce(() => page([]));
    const { unmount } = render(<StaffPage />);
    expect(await screen.findByText(/No staff match/)).toBeVisible();
    unmount();

    api.listStaff.mockImplementationOnce(() => fail('generic', 500));
    render(<StaffPage />);
    expect(await screen.findByText('The staff list could not be loaded.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeVisible();
  });

  it('searches after a short pause and filters by status, always from the first page', async () => {
    render(<StaffPage />);
    await screen.findByRole('table');

    await userEvent.type(screen.getByLabelText('Search staff'), 'sam');
    await waitFor(() => expect(api.listStaff).toHaveBeenLastCalledWith({ q: 'sam', status: '' }));
    expect(api.listStaff).not.toHaveBeenCalledWith({ q: 's', status: '' });

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'invited');
    await waitFor(() =>
      expect(api.listStaff).toHaveBeenLastCalledWith({ q: 'sam', status: 'invited' }),
    );
  });

  it('loads the next page with its cursor and adds the rows', async () => {
    api.listStaff
      .mockImplementationOnce(() => page([ROWS[0] as StaffRow], 'cursor-1'))
      .mockImplementationOnce(() => page([ROWS[1] as StaffRow]));
    render(<StaffPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(api.listStaff).toHaveBeenLastCalledWith({ q: '', status: '' }, 'cursor-1');
    expect(await screen.findByRole('row', { name: /Sam Carter/ })).toBeVisible();
    expect(screen.getByRole('row', { name: /Amira Admin/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  describe('row actions', () => {
    it('offers the right actions for each status, and never lets an admin disable themselves', async () => {
      render(<StaffPage />);

      await openMenu('Sam Carter');
      expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Reset password' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Sign out everywhere' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Disable' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Resend invite' })).not.toBeInTheDocument();
      await userEvent.keyboard('{Escape}');

      await openMenu('Nour Newhire');
      expect(screen.getByRole('menuitem', { name: 'Resend invite' })).toBeVisible();
      await userEvent.keyboard('{Escape}');

      await openMenu('Gil Gone');
      expect(screen.getByRole('menuitem', { name: 'Enable' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Disable' })).not.toBeInTheDocument();
      await userEvent.keyboard('{Escape}');

      await openMenu('Amira Admin');
      expect(screen.queryByRole('menuitem', { name: 'Disable' })).not.toBeInTheDocument();
    });

    it('hides reset password, reset two factor and sign out everywhere on the admin own row only', async () => {
      api.listStaff.mockImplementation(() =>
        page([
          row({ id: 'me-id', name: 'Amira Admin', role: 'admin', twoFactorEnabled: true }),
          row({ id: 'sam-id', name: 'Sam Carter', twoFactorEnabled: true }),
        ]),
      );
      render(<StaffPage />);

      await openMenu('Amira Admin');
      expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Reset password' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Reset two factor' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('menuitem', { name: 'Sign out everywhere' }),
      ).not.toBeInTheDocument();
      await userEvent.keyboard('{Escape}');

      await openMenu('Sam Carter');
      expect(screen.getByRole('menuitem', { name: 'Reset password' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Reset two factor' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Sign out everywhere' })).toBeVisible();
    });

    it('hides resend invite when the install sends no mail', async () => {
      loadConfig.mockResolvedValue({ mailEnabled: false, languages: ['en'] });
      render(<StaffPage />);

      await openMenu('Nour Newhire');

      expect(screen.queryByRole('menuitem', { name: 'Resend invite' })).not.toBeInTheDocument();
    });

    it('disables after a confirmation that names the action, with an optional reason', async () => {
      api.disableStaff.mockImplementation(() => ok({}));
      render(<StaffPage />);

      await openMenu('Sam Carter');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Disable' }));
      const dialog = await screen.findByRole('dialog', { name: 'Disable Sam Carter?' });
      await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'Left the company');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Disable account' }));

      await waitFor(() =>
        expect(api.disableStaff).toHaveBeenCalledWith('sam-id', 'Left the company'),
      );
      expect(await screen.findByText('Account disabled.')).toBeVisible();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.listStaff).toHaveBeenCalledTimes(2);
    });

    it('keeps the dialog open and says why when the api refuses (last admin)', async () => {
      api.disableStaff.mockImplementation(() => fail('LAST_ADMIN'));
      render(<StaffPage />);

      await openMenu('Sam Carter');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Disable' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Disable account' }));

      expect(
        await screen.findByText('There must always be at least one active administrator.'),
      ).toBeVisible();
      expect(screen.getByRole('dialog')).toBeVisible();
    });

    it('points to the Account page when the api refuses an action on yourself (SELF_ACTION)', async () => {
      api.resetStaffPassword.mockImplementation(() => fail('SELF_ACTION'));
      render(<StaffPage />);

      await openMenu('Sam Carter');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Reset password' }));
      await userEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset password' }),
      );

      expect(
        await screen.findByText(
          'Use your Account page to change your own password, two factor or sessions.',
        ),
      ).toBeVisible();
      expect(screen.getByRole('dialog')).toBeVisible();
    });

    it('shows a temporary password once after a reset with no mail', async () => {
      loadConfig.mockResolvedValue({ mailEnabled: false, languages: ['en'] });
      api.resetStaffPassword.mockImplementation(() =>
        ok({ setup: { mode: 'temporary_password', temporaryPassword: 'Tmp-Pass-12345678' } }),
      );
      render(<StaffPage />);

      await openMenu('Sam Carter');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Reset password' }));
      const confirm = await screen.findByRole('dialog', {
        name: 'Reset the password for Sam Carter?',
      });
      expect(confirm).toHaveTextContent('You will see a temporary password once');
      await userEvent.click(within(confirm).getByRole('button', { name: 'Reset password' }));

      const shown = await screen.findByRole('dialog', {
        name: 'Temporary password for Sam Carter',
      });
      expect(shown).toHaveTextContent('Tmp-Pass-12345678');
      await userEvent.click(within(shown).getByRole('button', { name: 'Done' }));
      expect(screen.queryByText('Tmp-Pass-12345678')).not.toBeInTheDocument();
    });

    it('says an email went out after a reset with mail on', async () => {
      api.resetStaffPassword.mockImplementation(() => ok({ setup: { mode: 'email' } }));
      render(<StaffPage />);

      await openMenu('Sam Carter');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Reset password' }));
      await userEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset password' }),
      );

      expect(await screen.findByText(/valid for 1 hour/)).toBeVisible();
    });

    it('signs a person out everywhere, enables, and re-sends an invite', async () => {
      api.revokeStaffSessions.mockImplementation(() => ok({ count: 2 }));
      api.enableStaff.mockImplementation(() => ok({}));
      api.resendInvite.mockImplementation(() => ok({ ok: true }));
      render(<StaffPage />);

      await openMenu('Sam Carter');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out everywhere' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
      expect(await screen.findByText('Signed out everywhere.')).toBeVisible();
      expect(api.revokeStaffSessions).toHaveBeenCalledWith('sam-id');

      await openMenu('Gil Gone');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Enable' }));
      expect(await screen.findByText('Account enabled.')).toBeVisible();
      expect(api.enableStaff).toHaveBeenCalledWith('gone-id');

      await openMenu('Nour Newhire');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Resend invite' }));
      expect(await screen.findByText('Invite sent again.')).toBeVisible();
      expect(api.resendInvite).toHaveBeenCalledWith('new-id');
    });
  });

  it('resets two factor only for someone who has it on, after a confirmation (AC-20)', async () => {
    api.resetStaffTwoFactor.mockImplementation(() => ok({}));
    render(<StaffPage />);

    await openMenu('Sam Carter');
    expect(screen.queryByRole('menuitem', { name: 'Reset two factor' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await openMenu('Gil Gone');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reset two factor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset two factor for Gil Gone?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset two factor' }));

    expect(await screen.findByText('Two factor reset.')).toBeVisible();
    expect(api.resetStaffTwoFactor).toHaveBeenCalledWith('gone-id');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the add dialog, and shows the temporary password of the new account', async () => {
    loadConfig.mockResolvedValue({ mailEnabled: false, languages: ['en', 'ar'] });
    api.createStaff.mockImplementation(() =>
      ok({
        staff: ROWS[1],
        setup: { mode: 'temporary_password', temporaryPassword: 'New-Pass-1234567' },
      }),
    );
    render(<StaffPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Add staff' }));
    const form = await screen.findByRole('dialog', { name: 'Add staff' });
    await userEvent.type(within(form).getByLabelText(/^Name/), 'Sam Carter');
    await userEvent.type(within(form).getByLabelText(/^Email/), 'sam@example.com');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByRole('dialog', { name: /Temporary password for Sam Carter/ }),
    ).toHaveTextContent('New-Pass-1234567');
    expect(await screen.findByText('Account created.')).toBeVisible();
  });

  describe('editing an email', () => {
    const detail = (status: 'invited' | 'active', email = 'nour@example.com') => ({
      ...ROWS[2],
      status,
      email,
      phone: null,
      staffCode: null,
      language: null,
    });

    async function editAndSave(status: 'invited' | 'active', newEmail: string | null) {
      api.listStaff.mockImplementation(() => page(ROWS));
      api.getStaff.mockImplementation(() => ok(detail(status)));
      api.updateStaff.mockImplementation(() => ok(detail(status, newEmail ?? 'nour@example.com')));
      render(<StaffPage />);
      await openMenu('Nour Newhire');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
      const form = await screen.findByRole('dialog');
      await waitFor(() => expect(within(form).getByLabelText(/^Name/)).toHaveValue('Nour Newhire'));
      if (newEmail) {
        const email = within(form).getByLabelText(/^Email/);
        await userEvent.clear(email);
        await userEvent.type(email, newEmail);
      } else {
        await userEvent.type(within(form).getByLabelText(/^Name/), 'x');
      }
      await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    }

    it('says a new invite was sent when mail is on', async () => {
      await editAndSave('invited', 'nour2@example.com');
      expect(
        await screen.findByText('Email changed. A new invite was sent to the new address.'),
      ).toBeVisible();
    });

    it('points to Reset password when mail is off', async () => {
      loadConfig.mockResolvedValue({ mailEnabled: false, languages: ['en'] });
      await editAndSave('invited', 'nour2@example.com');
      expect(
        await screen.findByText(
          'Email changed. Use Reset password to give this person a new temporary password.',
        ),
      ).toBeVisible();
    });

    it('keeps the plain message when the email did not change', async () => {
      await editAndSave('invited', null);
      expect(await screen.findByText('Saved.')).toBeVisible();
      expect(screen.queryByText(/Email changed/)).not.toBeInTheDocument();
    });
  });
});
