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
  hats: ['warehouse'],
  costView: false,
  status: 'active',
  lastSignInAt: '2026-11-02T09:30:00.000Z',
  twoFactorEnabled: false,
  phone: '+20 100 123 4567',
  staffCode: 'SC1',
  language: 'ar',
  disableReason: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.123456Z',
};

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const fail = (code: string) => Promise.resolve({ ok: false as const, status: 409, code });

function show(editId: string | null = null, canChangeCost = true) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <StaffFormDialog
      editId={editId}
      languages={['en', 'ar']}
      canChangeCost={canChangeCost}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
  return { onSaved, onClose };
}

const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }));
const hat = (name: string) => screen.getByRole('checkbox', { name });
const costSwitch = () => screen.getByRole('switch', { name: 'Sees cost' });

/** Fills the two required text fields with valid values. */
async function fillDetails() {
  await userEvent.type(await screen.findByLabelText(/^Name/), 'Sam');
  await userEvent.type(screen.getByLabelText(/^Email/), 'sam@example.com');
}

describe('StaffFormDialog (AC-12, AC-15)', () => {
  afterEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  describe('adding', () => {
    it('labels every field and marks the required ones (AC-24)', async () => {
      show();

      expect(await screen.findByLabelText('Name(Required)')).toBeRequired();
      expect(screen.getByLabelText('Email(Required)')).toBeRequired();
      expect(screen.queryByLabelText('Role')).not.toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Hats(Required)' })).toBeVisible();
      expect(costSwitch()).not.toBeChecked();
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

    it('offers a checkbox with its description for every staff hat, never partner (spec 0008, AC-18)', async () => {
      show();
      await screen.findByLabelText(/^Name/);

      const names = ['Support', 'Operations', 'Warehouse', 'Manager', 'Media buyer'];
      for (const name of names) expect(hat(name)).not.toBeChecked();
      expect(screen.getAllByRole('checkbox')).toHaveLength(names.length);
      expect(screen.queryByRole('checkbox', { name: 'Partner' })).not.toBeInTheDocument();
      expect(hat('Warehouse')).toHaveAccessibleDescription(
        'Picks, packs, ships, and receives stock; edits SKU names and prices.',
      );
    });

    it('needs at least one hat, and focuses the hats when they are the first problem (spec 0008, AC-14)', async () => {
      show();
      await fillDetails();

      await save();

      expect(hat('Support')).toHaveFocus();
      expect(screen.getByRole('group', { name: 'Hats(Required)' })).toHaveAccessibleDescription(
        /Pick at least one hat\./,
      );
      expect(api.createStaff).not.toHaveBeenCalled();
    });

    it('turns the cost switch on when manager or operations is ticked, off again when untouched (spec 0008, AC-7)', async () => {
      show();
      await screen.findByLabelText(/^Name/);

      await userEvent.click(hat('Warehouse'));
      expect(costSwitch()).not.toBeChecked();
      await userEvent.click(hat('Operations'));
      expect(costSwitch()).toBeChecked();
      await userEvent.click(hat('Operations'));
      expect(costSwitch()).not.toBeChecked();
      await userEvent.click(hat('Manager'));
      expect(costSwitch()).toBeChecked();
    });

    it('keeps the cost switch where the manager put it by hand', async () => {
      const { onSaved } = show();
      api.createStaff.mockImplementation(() => ok({ staff: DETAIL, setup: { mode: 'email' } }));
      await fillDetails();
      await userEvent.click(hat('Operations'));
      await userEvent.click(costSwitch());
      await userEvent.click(hat('Support'));
      expect(costSwitch()).not.toBeChecked();

      await save();

      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(api.createStaff).toHaveBeenCalledWith(
        expect.objectContaining({ hats: ['support', 'operations'], costView: false }),
      );
    });

    it('disables the cost switch, says why, and never prefills it without cost.view (AC-7 amendment)', async () => {
      show(null, false);
      await screen.findByLabelText(/^Name/);

      await userEvent.click(hat('Manager'));

      expect(costSwitch()).toBeDisabled();
      expect(costSwitch()).not.toBeChecked();
      expect(costSwitch()).toHaveAccessibleDescription(
        /Only a person who sees cost can turn this on or off\./,
      );
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
      await userEvent.click(hat('Manager'));
      await userEvent.click(hat('Warehouse'));

      await save();

      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(api.createStaff).toHaveBeenCalledWith({
        name: ' Sam Carter ',
        email: 'Sam@Example.com',
        hats: ['warehouse', 'manager'],
        costView: true,
      });
      expect(onSaved).toHaveBeenCalledWith({ staff: DETAIL, created: { mode: 'email' } });
    });

    it('puts a taken email and a taken staff code on their own fields', async () => {
      show();
      api.createStaff
        .mockImplementationOnce(() => fail('EMAIL_TAKEN'))
        .mockImplementationOnce(() => fail('STAFF_CODE_TAKEN'));
      await fillDetails();
      await userEvent.click(hat('Support'));

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
      await fillDetails();
      await userEvent.click(hat('Support'));

      await save();

      expect(
        await screen.findByText('That language is not enabled on this install.'),
      ).toBeVisible();
      expect(screen.getByLabelText(/^Name/)).toHaveValue('Sam');
    });

    it('says a cost refusal in plain words (403 FORBIDDEN)', async () => {
      show();
      api.createStaff.mockImplementation(() => fail('FORBIDDEN'));
      await fillDetails();
      await userEvent.click(hat('Support'));

      await save();

      expect(
        await screen.findByText('Only a person who sees cost can turn cost on or off for someone.'),
      ).toBeVisible();
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
      // Hats change in their own dialog, never here.
      expect(screen.queryByRole('group', { name: /^Hats/ })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Role')).not.toBeInTheDocument();
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
