'use client';

import type { CustomerMergeRequest, CustomerMergeResponse } from '@ssdashboard/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { customerKeys, mergeCustomers, undoCustomerMerge } from './customers-api';
import { mergeErrorKey, type MergeErrorKey } from './merge-error-key';

/** How long the Undo toast stays: long enough to reach its button by keyboard (Alt+T, then Tab); the profile keeps an Undo while it is allowed. */
const UNDO_TOAST_MS = 15_000;

/** What `useMergeActions` hands to a screen. */
export interface MergeActions {
  /**
   * Merges two customers and shows the toast that offers Undo. Resolves with the answer, or
   * throws the `ApiError` for the screen to show beside its button.
   */
  merge(request: CustomerMergeRequest): Promise<CustomerMergeResponse>;
  /**
   * Undoes one merge with the reason `wrong_merge` and says so in a toast (a failure too). Never
   * throws; resolves null when the merge was undone, else the message key of the failure so the
   * screen can show it beside its button as well (a toast is never the only place).
   */
  undo(mergeId: string): Promise<MergeErrorKey | null>;
}

/**
 * The merge and the undo of spec 0014 (AC-7, AC-8), shared by the merge page, the To review tab,
 * and the profile. They are plain async functions, not mutations bound to one screen, so the Undo
 * on the toast still works after the merge page has gone. Every call refreshes the customer
 * queries (a merge does not wait for the refresh). Never put a name or phone in a toast: the text is fixed.
 */
export function useMergeActions(): MergeActions {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const undo = useCallback(
    async (mergeId: string) => {
      try {
        await undoCustomerMerge(mergeId, { reasonCode: 'wrong_merge' });
        toast.success(t('customers.merge.undone'));
        return null;
      } catch (error) {
        const key = mergeErrorKey(error);
        toast.error(t(key));
        return key;
      } finally {
        await queryClient.invalidateQueries({ queryKey: customerKeys.all });
      }
    },
    [t, queryClient],
  );

  const merge = useCallback(
    async (request: CustomerMergeRequest) => {
      try {
        const done = await mergeCustomers(request);
        toast.success(t('customers.merge.done'), {
          duration: UNDO_TOAST_MS,
          action: { label: t('customers.merge.undo'), onClick: () => void undo(done.mergeId) },
        });
        return done;
      } finally {
        // Not awaited: the merge page navigates away at once, and waiting for the refetch would
        // show the merged slot answering with the survivor (a false "already the same customer").
        void queryClient.invalidateQueries({ queryKey: customerKeys.all });
      }
    },
    [t, queryClient, undo],
  );

  return { merge, undo };
}
