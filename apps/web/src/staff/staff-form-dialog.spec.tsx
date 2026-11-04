import type { StaffDetail } from '@ssdashboard/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaffFormDialog } from './staff-form-dialog';

const api = vi.hoisted(() => ({
  getStaff: vi.fn(),
  createStaff: vi.fn(),
  updateStaff: vi.fn(),
}));
vi.mock('./staff-api', () => api);

const DETAIL: StaffDetail = {
  id: 'sam-id',
  name: 'Sam Carter',
  email: 'sam@example.com',
  role: 'staff',
  status: 'active',
  lastSignInAt: '2026-11-02T09:30:00.000Z',
  twoFactorEnabled: false,
  phone: '+20 100 123 4567',
  staffCode: 'SC1',
  language: 'ar',
  disableReason: null,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const fail = (code: string) => Promise.resolve({ ok: false as const, status: 409, code });

function show(editId: string | null = null) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <StaffFormDialog
      editId={editId}
      languages={['en', 'ar']}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
  return { onSaved, onClose };
}

const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('StaffFormDialog (AC-12, AC-15)', () => {
  afterEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  describe('adding', () => {
    it('labels every field and marks the required ones (AC-24)', async () => {
      show();

      expect(await screen.findByLabelText('Name(Required)')).toBeRequired();
      expect(screen.getByLabelText('Email(Required)')).toBeRequired();
      expect(screen.getByLabelText('Role')).toHaveValue('staff');
      expect(screen.getByLabelText('Language')).toHaveValue('');
      expect(screen.getByLabelText('Phone')).toBeInTheDocument();
      expect(screen.getByLabelText('Staff code')).toBeInTheDocument();
    });

    it('names each problem, links it to its field, and focuses the first', async () => {
      show();
      await screen.findByLabelText(/^Name/);

      await save();

      const name = screen.getByLabelText(/^Name/);
      expect(name).toHaveAccessibleDescription('Enter a name.');
      expect(screen.getByLabelText(/^Email/)).toHaveAccessibleDescription(
        'Enter an email address.',
      );
      expect(name).toHaveFocus();
      expect(api.createStaff).not.toHaveBeenCalled();
    });

    it('checks the email, phone and staff code', async () => {
      show();
      await userEvent.type(await screen.findByLabelText(/^Name/), 'Sam');
      await userEvent.type(screen.getByLabelText(/^Email/), 'sam@');
      await userEvent.type(screen.getByLabelText('Phone'), '12');
      await userEvent.type(screen.getByLabelText('Staff code'), 'x'.repeat(21));

      await save();

      expect(screen.getByLabelText(/^Email/)).toHaveAccessibleDescription(
        'Enter a valid email address, like name@example.com.',
      );
      expect(screen.getByLabelText('Phone')).toHaveAccessibleDescription(
        'Use 5 to 30 digits, plus signs or spaces.',
      );
      expect(screen.getByLabelText('Staff code')).toHaveAccessibleDescription(
        'Use 1 to 20 characters.',
      );
    });

    it('sends only what was filled in, and hands back how the person gets their password', async () => {
      const { onSaved } = show();
      api.createStaff.mockImplementation(() => ok({ staff: DETAIL, setup: { mode: 'email' } }));
      await userEvent.type(await screen.findByLabelText(/^Name/), ' Sam Carter ');
      await userEvent.type(screen.getByLabelText(/^Email/), 'Sam@Example.com');
      await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin');

      await save();

      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(api.createStaff).toHaveBeenCalledWith({
        name: ' Sam Carter ',
        email: 'Sam@Example.com',
        role: 'admin',
      });
      expect(onSaved).toHaveBeenCalledWith({ staff: DETAIL, created: { mode: 'email' } });
    });

    it('puts a taken email and a taken staff code on their own fields', async () => {
      show();
      api.createStaff
        .mockImplementationOnce(() => fail('EMAIL_TAKEN'))
        .mockImplementationOnce(() => fail('STAFF_CODE_TAKEN'));
      await userEvent.type(await screen.findByLabelText(/^Name/), 'Sam');
      await userEvent.type(screen.getByLabelText(/^Email/), 'sam@example.com');

      await save();
      expect(await screen.findByLabelText(/^Email/)).toHaveAccessibleDescription(
        'Another account already uses this email.',
      );
      expect(screen.getByLabelText(/^Email/)).toHaveFocus();

      await save();
      await waitFor(() =>
        expect(screen.getByLabelText('Staff code')).toHaveAccessibleDescription(
          'Another account already uses this staff code.',
        ),
      );
    });

    it('shows other refusals at the top and keeps what was typed', async () => {
      show();
      api.createStaff.mockImplementation(() => fail('INVALID_LANGUAGE'));
      await userEvent.type(await screen.findByLabelText(/^Name/), 'Sam');
      await userEvent.type(screen.getByLabelText(/^Email/), 'sam@example.com');

      await save();

      expect(
        await screen.findByText('That language is not enabled on this install.'),
      ).toBeVisible();
      expect(screen.getByLabelText(/^Name/)).toHaveValue('Sam');
    });

    it('closes on Cancel without saving', async () => {
      const { onClose } = show();
      await screen.findByLabelText(/^Name/);

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onClose).toHaveBeenCalled();
      expect(api.createStaff).not.toHaveBeenCalled();
    });
  });

  describe('editing', () => {
    it('loads the person, and locks the email once they have signed in', async () => {
      api.getStaff.mockImplementation(() => ok(DETAIL));
      show('sam-id');

      await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('Sam Carter'));
      expect(screen.getByLabelText(/^Email/)).toBeDisabled();
      expect(screen.getByLabelText(/^Email/)).toHaveAccessibleDescription(
        'The email can only change until the person first signs in.',
      );
      expect(screen.getByLabelText('Phone')).toHaveValue('+20 100 123 4567');
      expect(screen.getByLabelText('Staff code')).toHaveValue('SC1');
      expect(screen.getByLabelText('Language')).toHaveValue('ar');
    });

    it('leaves the email editable while the account is invited', async () => {
      api.getStaff.mockImplementation(() =>
        ok({ ...DETAIL, status: 'invited', lastSignInAt: null }),
      );
      show('sam-id');

      await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('Sam Carter'));
      expect(screen.getByLabelText(/^Email/)).toBeEnabled();
    });

    it('sends emptied fields as empty text so they are cleared, and omits a locked email', async () => {
      api.getStaff.mockImplementation(() => ok(DETAIL));
      api.updateStaff.mockImplementation(() => ok(DETAIL));
      const { onSaved } = show('sam-id');
      await waitFor(() => expect(screen.getByLabelText('Phone')).toHaveValue('+20 100 123 4567'));
      await userEvent.clear(screen.getByLabelText('Phone'));

      await save();

      await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ staff: DETAIL }));
      expect(api.updateStaff).toHaveBeenCalledWith('sam-id', {
        name: 'Sam Carter',
        role: 'staff',
        phone: '',
        staffCode: 'SC1',
        language: 'ar',
      });
    });

    it('says so when the person cannot be loaded', async () => {
      api.getStaff.mockImplementation(() => fail('NOT_FOUND'));
      show('sam-id');

      expect(
        await screen.findByText('Something went wrong. Check your connection and try again.'),
      ).toBeVisible();
    });
  });
});
