import { z } from 'zod';
import { MergeSuggestionReason } from './customer-enums.js';
import {
  CustomerDismissReasonCode,
  CustomerMergeReasonCode,
  CustomerUnmergeReasonCode,
} from './customer-reason-codes.js';
import { CustomerBrief } from './customer-views.js';

const Timestamp = z.iso.datetime({ offset: true });

/**
 * `POST /api/customers/merges` (spec 0014 AC-6): merge `mergedId` into `survivorId`, with an
 * optional reason code and the suggestion it applies. Ids and codes only, never a name or phone.
 * A reason code the registry does not list is 422 `REASON_INVALID`.
 */
export const CustomerMergeRequest = z.strictObject({
  survivorId: z.uuid(),
  mergedId: z.uuid(),
  reasonCode: CustomerMergeReasonCode.optional(),
  suggestionId: z.uuid().optional(),
});
/** The validated shape of `CustomerMergeRequest`. */
export type CustomerMergeRequest = z.infer<typeof CustomerMergeRequest>;

/** The answer of a merge: the new merge's id (what Undo takes) and the survivor as a brief. */
export const CustomerMergeResponse = z.object({
  mergeId: z.uuid(),
  survivor: CustomerBrief,
});
/** The validated shape of `CustomerMergeResponse`. */
export type CustomerMergeResponse = z.infer<typeof CustomerMergeResponse>;

/**
 * `POST /api/customers/merges/:id/undo` (spec 0014 AC-8): the reason code is required (422
 * `REASON_REQUIRED` when missing, 422 `REASON_INVALID` for an unlisted code).
 */
export const CustomerUndoMergeRequest = z.strictObject({
  reasonCode: CustomerUnmergeReasonCode,
});
/** The validated shape of `CustomerUndoMergeRequest`. */
export type CustomerUndoMergeRequest = z.infer<typeof CustomerUndoMergeRequest>;

/** The answer of an undo: the customer that is canonical again, and the survivor it left. */
export const CustomerUndoMergeResponse = z.object({
  restoredId: z.uuid(),
  survivorId: z.uuid(),
});
/** The validated shape of `CustomerUndoMergeResponse`. */
export type CustomerUndoMergeResponse = z.infer<typeof CustomerUndoMergeResponse>;

/**
 * The refusal codes of an undo that a later change got in the way of (spec 0014 AC-8): the
 * customer route answers them as the 409 `code`, the audit screen's undo as the 409
 * `UNDO_NOT_POSSIBLE` with this `undoCode`.
 */
export const CustomerUndoRefusalCode = z.enum(['MERGE_NOT_LATEST', 'MERGE_ALREADY_UNDONE']);
/** One undo refusal code. */
export type CustomerUndoRefusalCode = z.infer<typeof CustomerUndoRefusalCode>;

/**
 * Every stable error code the merge, undo, and suggestion routes answer, so a screen can map
 * each to its own message. The answer's message is fixed text and never holds personal data.
 */
export const CustomerMergeErrorCode = z.enum([
  'CUSTOMER_NOT_FOUND',
  'SAME_CUSTOMER',
  'CUSTOMER_MERGED',
  'CUSTOMER_CHANGED',
  'SUGGESTION_NOT_FOUND',
  'SUGGESTION_CLOSED',
  'SUGGESTION_MISMATCH',
  'MERGE_NOT_FOUND',
  'MERGE_ALREADY_UNDONE',
  'MERGE_NOT_LATEST',
  'REASON_REQUIRED',
  'REASON_INVALID',
  'VALIDATION_FAILED',
  'INVALID_QUERY',
  'INVALID_CURSOR',
]);
/** One merge route error code. */
export type CustomerMergeErrorCode = z.infer<typeof CustomerMergeErrorCode>;

/** `GET /api/customers/merge-suggestions` query: keyset paged, `limit` 1 to 100 (default 25). */
export const MergeSuggestionListQuery = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
/** The validated shape of `MergeSuggestionListQuery`, after defaults. */
export type MergeSuggestionListQuery = z.infer<typeof MergeSuggestionListQuery>;

/**
 * One open merge suggestion (spec 0014 AC-9): why it was opened, when, and the two canonical
 * customers it names today, the older record first (the screen's default survivor).
 */
export const MergeSuggestionItem = z.object({
  id: z.uuid(),
  reason: MergeSuggestionReason,
  createdAt: Timestamp,
  customers: z.tuple([CustomerBrief, CustomerBrief]),
});
/** The validated shape of `MergeSuggestionItem`. */
export type MergeSuggestionItem = z.infer<typeof MergeSuggestionItem>;

/**
 * The answer of the suggestions list: open suggestions oldest first, a pair already merged left
 * out, the next cursor or null, and how many open suggestions there are in all.
 */
export const MergeSuggestionPage = z.object({
  items: z.array(MergeSuggestionItem),
  nextCursor: z.string().nullable(),
  openCount: z.number().int().min(0),
});
/** The validated shape of `MergeSuggestionPage`. */
export type MergeSuggestionPage = z.infer<typeof MergeSuggestionPage>;

/** `POST /api/customers/merge-suggestions/:id/dismiss`: an optional reason code; answers 204. */
export const MergeSuggestionDismissRequest = z.strictObject({
  reasonCode: CustomerDismissReasonCode.optional(),
});
/** The validated shape of `MergeSuggestionDismissRequest`. */
export type MergeSuggestionDismissRequest = z.infer<typeof MergeSuggestionDismissRequest>;
