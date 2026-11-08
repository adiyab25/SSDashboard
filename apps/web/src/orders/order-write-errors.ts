import type { MessageKey } from '@ssdashboard/i18n';
import { ZodError } from 'zod';
import { ApiError } from '@/api/client';

/** The api codes that have their own sentence in `orders.new.errors`, shared by the edit and cancel dialogs and the order moves. */
const LABELLED_CODES: ReadonlySet<string> = new Set([
  'ORDER_LOCKED',
  'ORDER_NOT_FOUND',
  'ORDER_NEEDS_A_LINE',
  'EDIT_CHANGES_PAYMENT',
  'EDIT_OVERPAID',
  'EDIT_IN_SHOPIFY',
  'CANCEL_IN_SHOPIFY',
  'WRITE_BACK_OPEN',
  'LINE_SHORT',
  'GIFT_NOT_ALLOWED',
  'GIFT_MUST_STAY_FREE',
  'DUPLICATE_TARGET_REQUIRED',
  'INVALID_PHONE',
  'INVALID_PHONE_ALT',
  'INVALID_TRANSITION',
  'INVALID_BODY',
  'REASON_INVALID',
  'LINE_FULLY_DISCOUNTED',
  'VARIANT_UNKNOWN',
]);

/** True when the order changed since the page loaded (409 `ORDER_STALE`). */
export function isStaleAnswer(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'ORDER_STALE';
}

/** True when the app may not edit this order because it belongs in Shopify (409 `EDIT_IN_SHOPIFY`). */
export function isEditInShopify(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'EDIT_IN_SHOPIFY';
}

/** True when the app may not cancel this order because it belongs in Shopify (409 `CANCEL_IN_SHOPIFY`). */
export function isCancelInShopify(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'CANCEL_IN_SHOPIFY';
}

/**
 * True when the answer says the page is out of date with the order (it is locked, no longer in the
 * state the button assumed, or gone), so the caller refetches the order and shows the real state.
 */
export function isOutOfDate(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ['ORDER_LOCKED', 'INVALID_TRANSITION', 'ORDER_NOT_FOUND'].includes(error.code)
  );
}

/**
 * The catalog key that says what went wrong with an edit, a cancel, or a move, from the api's stable
 * code. A code with no sentence of its own falls back to the generic one; a stale order has its own
 * message because the caller refetches. Never shows the api's text, which may carry names.
 */
export function orderWriteErrorKey(error: unknown): MessageKey {
  if (error instanceof ZodError) return 'orders.new.errors.invalidForm';
  if (error instanceof ApiError) {
    if (error.status === 429) return 'orders.new.errors.rateLimited';
    if (error.code === 'ORDER_STALE') return 'orders.actions.stale';
    if (error.code === 'BUSY') return 'orders.actions.busy';
    if (error.code === 'FORBIDDEN') return 'orders.actions.forbidden';
    if (LABELLED_CODES.has(error.code)) return `orders.new.errors.${error.code}` as MessageKey;
  }
  return 'orders.actions.generic';
}
