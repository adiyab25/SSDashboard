import type { StaffDetail } from '@ssdashboard/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaffHatsDialog } from './staff-hats-dialog';

const api = vi.hoisted(() => ({
  getStaff: vi.fn(),
  replaceStaffAccess: vi.fn(),
}));
vi.mock('./staff-api', () => api);

const UPDATED_AT = '2026-11-05T10:00:00.123456Z';

const detail = (overrides: Partial<StaffDetail> = {}): StaffDetail => ({
  id: 'sam-id',
  name: 'Sam Carter',
  email: 'sam@example.com',
  hats: ['warehouse'],
  costView: false,
  status: 'active',
  lastSignInAt: null,
  twoFactorEnabled: false,
  phone: null,
  staffCode: null,
  language: null,
  disableReason: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: UPDATED_AT,
  ...overrides,
});

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const fail = (code: string, status = 409) => Promise.resolve({ ok: false as const, status, code });

async function show(held: Partial<StaffDetail> = {}, canChangeCost = true) {
  api.getStaff.mockImplementation(() => ok(detail(held)));
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <StaffHatsDialog
      staffId="sam-id"
      name="Sam Carter"
      canChangeCost={canChangeCost}
      opener={null}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
  await screen.findByRole('checkbox', { name: 'Support' });
  return { onSaved, onClose };
}

const hat = (name: string) => screen.getByRole('checkbox', { name });
const costSwitch = () => screen.getByRole('switch', { name: 'Sees cost' });
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save hats' }));

describe('StaffHatsDialog (spec 0008, AC-7, AC-12, AC-18)', () => {
  afterEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  it('shows what the person holds now, and starts on the first hat', async () => {
    await show({ hats: ['support', 'warehouse'], costView: true });

    expect(screen.getByRole('dialog', { name: 'Edit hats for Sam Carter' })).toBeVisible();
    expect(hat('Support')).toBeChecked();
    expect(hat('Warehouse')).toBeChecked();
    expect(hat('Manager')).not.toBeChecked();
    expect(costSwitch()).toBeChecked();
    // The dialog moves focus in after it mounts, and under load that lands a tick later.
    await waitFor(() => expect(hat('Support')).toHaveFocus());
    expect(screen.queryByRole('checkbox', { name: 'Partner' })).not.toBeInTheDocument();
  });

  it('gives a warehouse person support, keeping cost off, and sends the updatedAt read before', async () => {
    const { onSaved } = await show();
    const saved = detail({ hats: ['support', 'warehouse'], updatedAt: '2026-11-06T08:00:00.5Z' });
    api.replaceStaffAccess.mockImplementation(() => ok(saved));

    await userEvent.click(hat('Support'));
    expect(costSwitch()).not.toBeChecked();
    await save();

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(api.replaceStaffAccess).toHaveBeenCalledWith('sam-id', {
      hats: ['support', 'warehouse'],
      costView: false,
      updatedAt: UPDATED_AT,
    });
  });

  it('turns cost on when operations is added, and the manager can turn it off before saving', async () => {
    await show();
    api.replaceStaffAccess.mockImplementation(() => ok(detail()));

    await userEvent.click(hat('Operations'));
    expect(costSwitch()).toBeChecked();
    await userEvent.click(costSwitch());
    expect(costSwitch()).not.toBeChecked();
    await save();

    await waitFor(() =>
      expect(api.replaceStaffAccess).toHaveBeenCalledWith(
        'sam-id',
        expect.objectContaining({ hats: ['operations', 'warehouse'], costView: false }),
      ),
    );
  });

  it('needs at least one hat, and focuses the hats', async () => {
    await show();

    await userEvent.click(hat('Warehouse'));
    await save();

    expect(hat('Support')).toHaveFocus();
    expect(screen.getByRole('group', { name: 'Hats(Required)' })).toHaveAccessibleDescription(
      /Pick at least one hat\./,
    );
    expect(api.replaceStaffAccess).not.toHaveBeenCalled();
  });

  it('requires a reason only when manager is taken away, and sends it trimmed', async () => {
    await show({ hats: ['manager'], costView: true });
    api.replaceStaffAccess.mockImplementation(() => ok(detail()));
    expect(screen.getByLabelText('Reason (optional)')).not.toBeRequired();

    await userEvent.click(hat('Operations'));
    await userEvent.click(hat('Manager'));
    const reason = screen.getByLabelText('Reason (required when you take Manager away)');
    expect(reason).toHaveAttribute('aria-required', 'true');
    await save();

    expect(reason).toHaveFocus();
    expect(reason).toHaveAccessibleDescription(/Say why you are taking Manager away\./);
    expect(api.replaceStaffAccess).not.toHaveBeenCalled();

    await userEvent.type(reason, '  Moved to the shop floor  ');
    await save();

    await waitFor(() =>
      expect(api.replaceStaffAccess).toHaveBeenCalledWith('sam-id', {
        hats: ['operations'],
        costView: true,
        updatedAt: UPDATED_AT,
        reason: 'Moved to the shop floor',
      }),
    );
  });

  it('disables the cost switch, keeps the stored grant, and says why without cost.view', async () => {
    await show({ hats: ['warehouse'], costView: false }, false);
    api.replaceStaffAccess.mockImplementation(() => ok(detail()));

    await userEvent.click(hat('Manager'));

    expect(costSwitch()).toBeDisabled();
    expect(costSwitch()).not.toBeChecked();
    expect(costSwitch()).toHaveAccessibleDescription(
      /Only a person who sees cost can turn this on or off\./,
    );
    await save();
    await waitFor(() =>
      expect(api.replaceStaffAccess).toHaveBeenCalledWith(
        'sam-id',
        expect.objectContaining({ costView: false }),
      ),
    );
  });

  it.each([
    ['SELF_HAT_CHANGE', 409, 'You cannot change your own hats or cost. Ask another manager.'],
    [
      'LAST_ADMIN',
      409,
      'There must always be at least one active manager. Give Manager to someone else first.',
    ],
    ['FORBIDDEN', 403, 'Only a person who sees cost can turn cost on or off for someone.'],
    ['HAT_CONFLICT', 422, 'These hats cannot be worn together.'],
    ['GRANT_NOT_ALLOWED', 422, 'This person cannot be given cost.'],
    ['SOMETHING_NEW', 500, 'Something went wrong. Check your connection and try again.'],
  ])(
    'says %s in plain words, keeps the dialog open, and focuses the message',
    async (code, status, text) => {
      await show();
      api.replaceStaffAccess.mockImplementation(() => fail(code, status));

      await userEvent.click(hat('Support'));
      await save();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(text);
      await waitFor(() => expect(alert).toHaveFocus());
      expect(hat('Support')).toBeChecked();
      expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    },
  );

  it('puts NO_HAT and REASON_REQUIRED from the api on their fields', async () => {
    await show({ hats: ['manager', 'support'] });
    api.replaceStaffAccess
      .mockImplementationOnce(() => fail('NO_HAT', 422))
      .mockImplementationOnce(() => fail('REASON_REQUIRED', 422));

    await save();
    expect(await screen.findByText('Pick at least one hat.')).toBeVisible();
    expect(hat('Support')).toHaveFocus();

    await save();
    await waitFor(() =>
      expect(screen.getByLabelText(/^Reason/)).toHaveAccessibleDescription(
        /Say why you are taking Manager away\./,
      ),
    );
    expect(screen.getByLabelText(/^Reason/)).toHaveFocus();
  });

  it('says a stale record changed meanwhile and reloads what the person holds now', async () => {
    await show();
    api.replaceStaffAccess.mockImplementation(() => fail('STALE_RECORD'));

    await userEvent.click(hat('Support'));
    await save();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this person while you were editing. Reload to see what they hold now.',
    );
    api.getStaff.mockImplementation(() =>
      ok(detail({ hats: ['operations'], updatedAt: '2026-11-06T09:00:00.000001Z' })),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(hat('Operations')).toBeChecked());
    expect(hat('Support')).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(hat('Support')).toHaveFocus();
  });

  it('says so when the person cannot be loaded, and closes on Cancel without saving', async () => {
    api.getStaff.mockImplementation(() => fail('NOT_FOUND', 404));
    const onClose = vi.fn();
    render(
      <StaffHatsDialog
        staffId="sam-id"
        name="Sam Carter"
        canChangeCost
        opener={null}
        onSaved={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(await screen.findByText('This person could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save hats' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.replaceStaffAccess).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const { onClose } = await show();

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});
