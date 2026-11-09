import { CustomerFlagErrorCode } from '@ssdashboard/contracts';
import { ApiError } from '@/api/client';

/** The catalog key of a flag set or clear failure: one message per stable api code. */
export type FlagErrorKey = `customers.flagging.errors.${CustomerFlagErrorCode | 'generic'}`;

/**
 * Maps a failed flag call to its translated message key. A code the screen does not know falls
 * back to the generic message. The key is chosen from the api's stable `code` alone, so the note,
 * a name, or a phone never reaches the message.
 */
export function flagErrorKey(error: unknown): FlagErrorKey {
  if (error instanceof ApiError) {
    const known = CustomerFlagErrorCode.safeParse(error.code);
    if (known.success) return `customers.flagging.errors.${known.data}`;
  }
  return 'customers.flagging.errors.generic';
}
