import type { MessageKey } from '@ssdashboard/i18n';
import { ZodError } from 'zod';
import { ApiError } from '@/api/client';

/** The api codes that have their own sentence in `orders.stockOut.errors`. */
const LABELLED_CODES: ReadonlySet<string> = new Set([
  'NOTHING_AWAITING',
  'CLOSE_ALREADY_REQUESTED',
  'ALREADY_REQUESTED',
  'NO_LINES_DIFFER',
  'IDEMPOTENCY_CONFLICT',
  'STALE_RECORD',
  'PERIOD_LOCKED',
  'FORBIDDEN',
]);

/**
 * True when the answer says the page is out of date with the line (nothing, or less, awaits now,
 * or the order changed), so the caller refetches the order and shows what is really there.
 */
export function isStockOutOutOfDate(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'NOTHING_AWAITING' || error.code === 'STALE_RECORD')
  );
}

/**
 * The catalog key that says what went wrong with a restock or a close, from the api's stable
 * code. A code with no sentence of its own falls back to the generic one. Never shows the api's
 * text, which may carry names.
 */
export function stockOutErrorKey(error: unknown): MessageKey {
  if (error instanceof ZodError) return 'orders.new.errors.invalidForm';
  if (error instanceof ApiError) {
    if (error.status === 429) return 'orders.new.errors.rateLimited';
    if (error.code === 'BUSY') return 'orders.actions.busy';
    if (LABELLED_CODES.has(error.code)) return `orders.stockOut.errors.${error.code}` as MessageKey;
  }
  return 'orders.actions.generic';
}
