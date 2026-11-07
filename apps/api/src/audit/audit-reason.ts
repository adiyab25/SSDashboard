import { maskEmails, maskPhones } from '@ssdashboard/config/redaction';
import {
  ReasonCode,
  type AuditActionDefinition,
  type AuditReasonForm,
} from '@ssdashboard/contracts';
import { AuditReasonInvalid, AuditReasonRequired, AuditReasonTooLong } from './audit.errors.js';

/** The longest reason an entry keeps, after trimming (spec 0010, AC-5). */
export const AUDIT_REASON_MAX = 500;

/**
 * The reason an entry keeps, checked against its action's policy (spec 0010, AC-5), or null for
 * none. In order: a reason the action requires (or `reasonRequired` asks for) must be present
 * (`AuditReasonRequired`) and at most 500 characters as it is kept, after trimming and masking
 * (`AuditReasonTooLong`; `[email]` can be longer than the address it replaces, review M4R18, so
 * the limit is measured on the masked text, the one the table's `audit_reason_length` checks); on
 * a record type that keeps reason codes (`reasonForm` `code`: customer, order, exchange, outbound
 * command) it must be one of the action's `reasonCodes` with no phone in it
 * (`AuditReasonInvalid`, security reviews AS13, AS23) and is kept as it is; free text is kept
 * with its phones and emails masked. The writer runs it for every entry, and the undo runs it
 * before the owner's handler, so the handler only ever sees the checked, masked reason (review
 * M4R2, security review AS32). Pure: it never reads the database and never returns the raw text
 * of a refused reason.
 */
export function checkedAuditReason(
  action: string,
  definition: Pick<AuditActionDefinition, 'reason' | 'reasonCodes'>,
  reasonForm: AuditReasonForm,
  reason: string | undefined,
  reasonRequired = false,
): string | null {
  const trimmed = reason?.trim() ?? '';
  const required = definition.reason === 'required' || reasonRequired;
  if (!trimmed && required) throw new AuditReasonRequired(action);
  if (!trimmed) return null;
  if (reasonForm === 'code') {
    if ([...trimmed].length > AUDIT_REASON_MAX) throw new AuditReasonTooLong();
    // A customer facing record keeps a reason code, never a typed note (spec 0010, AC-5).
    // Only a code this action lists, and never one that holds a phone (security review AS23).
    if (
      !ReasonCode.safeParse(trimmed).success ||
      maskPhones(trimmed) !== trimmed ||
      !definition.reasonCodes?.includes(trimmed)
    ) {
      throw new AuditReasonInvalid(action);
    }
    return trimmed;
  }
  // Mask first, then measure: the kept text is what must fit (review M4R18).
  const masked = maskEmails(maskPhones(trimmed));
  if ([...masked].length > AUDIT_REASON_MAX) throw new AuditReasonTooLong();
  return masked;
}
