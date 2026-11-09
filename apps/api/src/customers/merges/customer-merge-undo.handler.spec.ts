import { describe, expect, it, vi } from 'vitest';
import type { AuditUndoContext } from '../../audit/audit-undo.registry.js';
import { UndoNotPossible } from '../../audit/audit.errors.js';
import type { Transaction } from '../../database/sql.js';
import { CustomersError, MergeAlreadyUndone, MergeNotLatest } from '../customers.errors.js';
import { CustomerMergeUndoHandler } from './customer-merge-undo.handler.js';
import type { CustomerMerges } from './customer-merges.service.js';

const MERGE = '01937f3a-0000-7000-8000-00000000000a';
const SURVIVOR = '01937f3a-0000-7000-8000-00000000000b';
const RESTORED = '01937f3a-0000-7000-8000-00000000000c';
const USER = '01937f3a-0000-7000-8000-00000000000d';
const tx = {} as Transaction;

const context = (args: Record<string, unknown>): AuditUndoContext => ({
  entry: {
    id: MERGE,
    action: 'customer.merged',
    correlationId: MERGE,
    record: { type: 'customer', id: RESTORED, label: null },
    before: null,
    after: null,
    undo: { action: 'customers.merge_undo', args },
  },
  actor: { kind: 'person', userId: USER, hat: 'manager' },
  reason: 'wrong_merge',
});

const handlerWith = (undoIn: CustomerMerges['undoIn']) =>
  new CustomerMergeUndoHandler({ undoIn } as unknown as CustomerMerges);

describe('CustomerMergeUndoHandler (spec 0014 AC-8)', () => {
  it('runs the merge undo as the person and answers the restored record', async () => {
    const undoIn = vi.fn<CustomerMerges['undoIn']>().mockResolvedValue({
      restoredId: RESTORED,
      survivorId: SURVIVOR,
      changed: [RESTORED],
    });

    const result = await handlerWith(undoIn).undo(tx, context({ mergeId: MERGE }));

    expect(undoIn).toHaveBeenCalledWith(tx, MERGE, 'wrong_merge', { userId: USER, hat: 'manager' });
    expect(result).toEqual({
      record: { type: 'customer', id: RESTORED },
      before: { mergedIntoId: SURVIVOR },
      after: { mergedIntoId: null, mergeId: MERGE },
    });
  });

  it.each([
    [new MergeNotLatest(), 'MERGE_NOT_LATEST'],
    [new MergeAlreadyUndone(), 'MERGE_ALREADY_UNDONE'],
    [new CustomersError('MERGE_NOT_FOUND', 'x'), undefined],
  ])('turns %s into UndoNotPossible with its declared code', async (error, undoCode) => {
    const undoIn = vi.fn<CustomerMerges['undoIn']>().mockRejectedValue(error);

    const refusal = await handlerWith(undoIn)
      .undo(tx, context({ mergeId: MERGE }))
      .catch((caught: unknown) => caught);

    expect(refusal).toBeInstanceOf(UndoNotPossible);
    expect((refusal as UndoNotPossible).undoCode).toBe(undoCode);
  });

  it('refuses malformed arguments without calling the service', async () => {
    const undoIn = vi.fn<CustomerMerges['undoIn']>();

    await expect(handlerWith(undoIn).undo(tx, context({ mergeId: 'x' }))).rejects.toBeInstanceOf(
      UndoNotPossible,
    );
    expect(undoIn).not.toHaveBeenCalled();
  });
});
