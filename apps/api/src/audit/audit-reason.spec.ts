import { describe, expect, it } from 'vitest';
import { AUDIT_REASON_MAX, checkedAuditReason } from './audit-reason.js';
import { AuditReasonRequired, AuditReasonTooLong } from './audit.errors.js';

const FREE = { reason: 'required' as const };

/** A free text reason of exactly `length` characters that holds two short addresses. */
function withTwoAddresses(length: number): string {
  const addresses = ' a@b.c and a@b.c';
  return `${'x'.repeat(length - addresses.length)}${addresses}`;
}

// Review M4R18: the 500 character limit holds for the text the entry keeps, after masking, so a
// reason never passes this check and then fails the table's `audit_reason_length` (a 500), or on
// the undo, the writer's second check after the owner's handler ran.
describe('checkedAuditReason length (review M4R18)', () => {
  it('measures the limit after masking: two short addresses grow a 498 character reason past 500', () => {
    const reason = withTwoAddresses(498);
    expect([...reason]).toHaveLength(498);

    expect(() => checkedAuditReason('sku.archived', FREE, 'text', reason)).toThrow(
      AuditReasonTooLong,
    );
  });

  it('keeps a reason whose masked text fits, and returns that text', () => {
    // 496 characters, 500 once each `a@b.c` (5) becomes `[email]` (7).
    const kept = checkedAuditReason('sku.archived', FREE, 'text', withTwoAddresses(496));

    expect(kept).toHaveLength(AUDIT_REASON_MAX);
    expect(kept?.endsWith(' [email] and [email]')).toBe(true);
  });

  it('still refuses a missing reason and a code over the limit', () => {
    expect(() => checkedAuditReason('sku.archived', FREE, 'text', '  ')).toThrow(
      AuditReasonRequired,
    );
    expect(() =>
      checkedAuditReason('customer.merged', FREE, 'code', 'x'.repeat(AUDIT_REASON_MAX + 1)),
    ).toThrow(AuditReasonTooLong);
  });
});
