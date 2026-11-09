import type {
  AuditActor,
  CustomerPhoneAddedReasonCode,
  NormalizedPhone,
} from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import type { AuditService } from '../../audit/audit.service.js';
import type { Transaction } from '../../database/sql.js';
import { CUSTOMER_PHONE_LOCK } from '../customer-locks.js';
import { CustomersError } from '../customers.errors.js';

/** What `CustomersService.addPhone` did (spec 0014 AC-10). */
export type AddPhoneOutcome = 'added' | 'already_held' | 'held_by_other';

/** The answer of `addPhone`: the outcome, and the other canonical customer for `held_by_other`. */
export interface AddPhoneResult {
  /** What happened. */
  outcome: AddPhoneOutcome;
  /** The canonical customer that holds the phone, only for `held_by_other`. */
  otherCustomerId?: string;
}

/**
 * Attaches a second phone to a customer (spec 0014 AC-10), in the caller's transaction, under the
 * same phone lock `findOrCreate` takes, so neither can fail on the unique phone key. A phone no
 * customer holds is attached to the canonical customer, not primary (`added`); a phone already on
 * the same canonical customer writes nothing (`already_held`); a phone on another customer is
 * never moved: it answers `held_by_other` with that customer's canonical id and opens one
 * `second_phone_conflict` suggestion for the pair (at most one row per pair, ever). A person's
 * `added` writes `customer.phone_added` (ids only, never the phone); a system job or an import
 * writes no entry. Throws `CUSTOMER_NOT_FOUND` for an unknown customer.
 */
export async function addPhone(
  tx: Transaction,
  audit: AuditService,
  customerId: string,
  phone: NormalizedPhone,
  actor: AuditActor,
  reasonCode?: CustomerPhoneAddedReasonCode,
): Promise<AddPhoneResult> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${CUSTOMER_PHONE_LOCK}::int, hashtext(${phone.e164}))`,
  );
  const canonical = (
    await tx.execute<{ id: string }>(sql`
      SELECT coalesce(merged_into_id, id) AS id FROM customers WHERE id = ${customerId}::uuid`)
  ).rows[0]?.id;
  if (canonical === undefined) {
    throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
  }
  const held = (
    await tx.execute<{ phone_id: string; customer_id: string }>(sql`
      SELECT p.id AS phone_id, coalesce(c.merged_into_id, c.id) AS customer_id
      FROM customer_phones p JOIN customers c ON c.id = p.customer_id
      WHERE p.phone_e164 = ${phone.e164}`)
  ).rows[0];

  if (held !== undefined) {
    if (held.customer_id === canonical) return { outcome: 'already_held' };
    await tx.execute(sql`
      INSERT INTO customer_merge_suggestions
        (customer_low_id, customer_high_id, reason, evidence_phone_id)
      VALUES (LEAST(${canonical}::uuid, ${held.customer_id}::uuid),
              GREATEST(${canonical}::uuid, ${held.customer_id}::uuid),
              'second_phone_conflict', ${held.phone_id}::uuid)
      ON CONFLICT ON CONSTRAINT customer_merge_suggestions_pair_unique DO NOTHING`);
    return { outcome: 'held_by_other', otherCustomerId: held.customer_id };
  }

  const inserted = (
    await tx.execute<{ id: string }>(sql`
      INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
      VALUES (${canonical}::uuid, ${phone.e164}, ${phone.kind}::customer_phone_kind, false)
      RETURNING id`)
  ).rows[0]?.id;
  if (inserted === undefined) throw new Error('The phone insert returned no row');
  if (actor.kind === 'person') {
    await audit.record(tx, {
      actor,
      action: 'customer.phone_added',
      record: { type: 'customer', id: canonical },
      after: { phoneId: inserted, isPrimary: false },
      ...(reasonCode === undefined ? {} : { reason: reasonCode }),
      correlationId: audit.newCorrelationId(actor),
    });
  }
  return { outcome: 'added' };
}
