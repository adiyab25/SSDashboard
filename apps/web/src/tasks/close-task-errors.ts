import type { MessageKey } from '@ssdashboard/i18n';
import { ZodError } from 'zod';
import { ApiError } from '@/api/client';

/** The api codes that have their own sentence in `tasks.close.errors`. */
const LABELLED_CODES: ReadonlySet<string> = new Set([
  'TASK_NOT_FOUND',
  'TASK_CHANGED',
  'TASK_NOT_OPEN',
  'OUTCOME_INVALID',
  'OUTCOME_NOT_FOR_PERSON',
  'NOTE_REQUIRED',
  'VALIDATION_FAILED',
]);

/** True when the task is gone, changed, or closed since the list loaded: the list must be read again. */
export function isTaskOutOfDate(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ['TASK_NOT_FOUND', 'TASK_CHANGED', 'TASK_NOT_OPEN'].includes(error.code)
  );
}

/**
 * The catalog key that says what went wrong with a close, from the api's stable code. A code with
 * no sentence of its own falls back to the generic one; it never shows the api's own text.
 */
export function closeTaskErrorKey(error: unknown): MessageKey {
  if (error instanceof ZodError) return 'tasks.close.errors.VALIDATION_FAILED';
  if (error instanceof ApiError) {
    if (error.status === 429) return 'tasks.close.errors.rateLimited';
    if (LABELLED_CODES.has(error.code)) {
      return `tasks.close.errors.${error.code}` as MessageKey;
    }
  }
  return 'tasks.close.errors.generic';
}
