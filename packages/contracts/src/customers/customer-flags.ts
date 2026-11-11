import { z } from 'zod';
import { CustomerRiskFlag } from './customer-enums.js';
import { CustomerFlagReasonCode, CustomerUnflagReasonCode } from './customer-reason-codes.js';
import { CustomerFlagView } from './customer-views.js';

const Timestamp = z.iso.datetime({ offset: true });

/**
 * The stamp a person sends back: an ISO timestamp from 1970 on. An earlier one was never issued,
 * and a year PostgreSQL cannot read would otherwise fail in the database instead of answering 422.
 */
const ExpectedStamp = Timestamp.refine((value) => Date.parse(value) >= 0, {
  message: 'The stamp is not one the api issued',
});

/**
 * The most characters a flag note may hold (spec 0014 AC-11). The note is personal data (Law
 * 151): it lives only on the customer row and never reaches a log line, an error, or an audit
 * entry. A longer note is 422 `NOTE_TOO_LONG`.
 */
export const CUSTOMER_FLAG_NOTE_MAX = 500;

/**
 * A flag note as stored: invisible format characters (`\p{Cf}`, such as direction marks) removed,
 * then trimmed, then held to `CUSTOMER_FLAG_NOTE_MAX`, so the cap counts what is kept.
 */
const FlagNote = z
  .string()
  .overwrite((value) => value.replace(/\p{Cf}/gu, ''))
  .trim()
  .max(CUSTOMER_FLAG_NOTE_MAX);

/**
 * `PUT /api/customers/:id/flag` (spec 0014 AC-11): sets a `manual` flag of `kind` on the
 * canonical customer, with an optional note and an optional reason code. `expectedUpdatedAt` is
 * the profile's `updatedAt`, sent back exactly (409 `STALE_RECORD` when it moved on). A null or
 * blank note stores no note; the note is cleaned of invisible format characters and trimmed before
 * its length is checked. The id must be canonical (409 `CUSTOMER_MERGED` otherwise).
 */
export const CustomerSetFlagRequest = z.strictObject({
  kind: CustomerRiskFlag,
  note: FlagNote.nullable().optional(),
  reasonCode: CustomerFlagReasonCode.optional(),
  expectedUpdatedAt: ExpectedStamp,
});
/** The validated shape of `CustomerSetFlagRequest`. */
export type CustomerSetFlagRequest = z.infer<typeof CustomerSetFlagRequest>;

/**
 * The answer of a flag set: the profile's flag block as it now reads, and the customer's new
 * `updatedAt` (the next `expectedUpdatedAt`).
 */
export const CustomerSetFlagResponse = z.object({
  flag: CustomerFlagView,
  updatedAt: Timestamp,
});
/** The validated shape of `CustomerSetFlagResponse`. */
export type CustomerSetFlagResponse = z.infer<typeof CustomerSetFlagResponse>;

/**
 * `POST /api/customers/:id/flag/clear` (spec 0014 AC-11, answers 204): clears the flag on every id
 * of the canonical customer. The reason code is required (422 `REASON_REQUIRED` when missing, 422
 * `REASON_INVALID` for an unlisted code); a merged id clears its survivor's flag.
 */
export const CustomerClearFlagRequest = z.strictObject({
  reasonCode: CustomerUnflagReasonCode,
  expectedUpdatedAt: ExpectedStamp,
});
/** The validated shape of `CustomerClearFlagRequest`. */
export type CustomerClearFlagRequest = z.infer<typeof CustomerClearFlagRequest>;

/**
 * Every stable error code the two flag routes answer, so a screen can map each to its own
 * message. The answer's message is fixed text and never holds the note, a name, or a phone.
 */
export const CustomerFlagErrorCode = z.enum([
  'CUSTOMER_NOT_FOUND',
  'CUSTOMER_MERGED',
  'STALE_RECORD',
  'NOT_FLAGGED',
  'REASON_REQUIRED',
  'REASON_INVALID',
  'NOTE_TOO_LONG',
  'VALIDATION_FAILED',
]);
/** One flag route error code. */
export type CustomerFlagErrorCode = z.infer<typeof CustomerFlagErrorCode>;
