import { CustomerMergeErrorCode } from '@ssdashboard/contracts';
import { ApiError } from '@/api/client';

/** The catalog key of a merge, undo, or suggestion failure: one message per stable api code. */
export type MergeErrorKey = `customers.merge.errors.${CustomerMergeErrorCode | 'generic'}`;

/**
 * Maps a failed merge, undo, or dismiss call to its translated message key. A code the screen does
 * not know falls back to the generic message. The message never carries a phone or a name: the
 * key is chosen from the api's stable `code` alone.
 */
export function mergeErrorKey(error: unknown): MergeErrorKey {
  if (error instanceof ApiError) {
    const known = CustomerMergeErrorCode.safeParse(error.code);
    if (known.success) return `customers.merge.errors.${known.data}`;
  }
  return 'customers.merge.errors.generic';
}
