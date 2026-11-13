import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { CloseTaskDialog } from './close-task-dialog';
import { closableTaskOf, TASK_ID } from './task-list-row-fixture';

const api = vi.hoisted(() => ({ closeTask: vi.fn() }));
vi.mock('./tasks-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  api.closeTask.mockReset();
  toast.success.mockReset();
});

function open(task = closableTaskOf()) {
  const onDismiss = vi.fn();
  renderWithQuery(<CloseTaskDialog task={task} onDismiss={onDismiss} onRestoreFocus={vi.fn()} />);
  return { onDismiss, task };
}

const fail = (status: number, code: string) =>
  api.closeTask.mockRejectedValue(new ApiError(status, { code }));

describe('CloseTaskDialog (spec 0016, AC-3, AC-14)', () => {
  it('lists the allowed outcomes with their catalog labels, never their codes', async () => {
    open();
    expect(await screen.findByRole('radio', { name: 'Synced to Shopify' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Resolved by a person' })).toBeVisible();
    expect(screen.queryByText('synced')).toBeNull();
  });

  it('closes with the outcome, the note, and the updatedAt the row showed', async () => {
    api.closeTask.mockResolvedValue(closableTaskOf());
    const { onDismiss, task } = open();

    await userEvent.click(await screen.findByRole('radio', { name: 'Resolved by a person' }));
    await userEvent.type(screen.getByLabelText(/Note/), '  Fixed in Shopify  ');
    await userEvent.click(screen.getByRole('button', { name: 'Close task' }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(api.closeTask).toHaveBeenCalledWith(TASK_ID, {
      outcome: 'resolved',
      note: 'Fixed in Shopify',
      expectedUpdatedAt: task.updatedAt,
    });
    expect(toast.success).toHaveBeenCalledWith('Task closed.');
  });

  it('sends no note when none is typed', async () => {
    api.closeTask.mockResolvedValue(closableTaskOf());
    const { onDismiss } = open();

    await userEvent.click(await screen.findByRole('radio', { name: 'Synced to Shopify' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close task' }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(api.closeTask.mock.calls[0]?.[1]).not.toHaveProperty('note');
  });

  it('asks for an outcome before it calls the api', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Close task' }));

    expect(await screen.findByText('Choose an outcome.')).toBeVisible();
    expect(api.closeTask).not.toHaveBeenCalled();
  });

  it('says a changed task changed (409 TASK_CHANGED) and only offers the way back', async () => {
    fail(409, 'TASK_CHANGED');
    const { onDismiss } = open();

    await userEvent.click(await screen.findByRole('radio', { name: 'Synced to Shopify' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone changed this task while you were looking.',
    );
    expect(screen.queryByRole('button', { name: 'Close task' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back to My work' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('says a closed task is closed (409 TASK_NOT_OPEN)', async () => {
    fail(409, 'TASK_NOT_OPEN');
    open();

    await userEvent.click(await screen.findByRole('radio', { name: 'Synced to Shopify' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This task is already closed.');
  });

  it('says a person may not set an outcome only the system sets (422 OUTCOME_NOT_FOR_PERSON)', async () => {
    fail(422, 'OUTCOME_NOT_FOR_PERSON');
    open();

    await userEvent.click(await screen.findByRole('radio', { name: 'Synced to Shopify' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only the system can set that outcome.',
    );
    // The person can pick another outcome and try again.
    expect(screen.getByRole('button', { name: 'Close task' })).toBeEnabled();
  });

  it.each([
    ['OUTCOME_INVALID', 'That outcome does not fit this task.'],
    ['NOTE_REQUIRED', 'This outcome needs a note.'],
    ['VALIDATION_FAILED', 'Check the outcome and the note'],
    ['TASK_NOT_FOUND', 'This task is gone'],
  ])('shows a plain sentence for %s', async (code, sentence) => {
    fail(code === 'TASK_NOT_FOUND' ? 404 : 422, code);
    open();

    await userEvent.click(await screen.findByRole('radio', { name: 'Synced to Shopify' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
  });

  it('shows the generic sentence for a code it does not know, never the api text', async () => {
    api.closeTask.mockRejectedValue(new ApiError(500, { code: 'SOMETHING_ELSE' }));
    open();

    await userEvent.click(await screen.findByRole('radio', { name: 'Synced to Shopify' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The task could not be closed.');
  });
});
