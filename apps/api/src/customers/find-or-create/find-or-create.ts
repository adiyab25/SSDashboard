import type { FindOrCreateOutcome, NormalizedPhone } from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import type { Transaction } from '../../database/sql.js';
import { CUSTOMER_EXTERNAL_ID_LOCK, CUSTOMER_PHONE_LOCK } from '../customer-locks.js';
import { CustomersError } from '../customers.errors.js';

/** The id an outside system gave a customer: a Shopify store's customer id, or a partner's own reference. */
export type ChannelCustomerRef =
  | { kind: 'shopify_customer'; connectionId: string; externalId: string }
  | { kind: 'partner_reference'; channelId: string; externalId: string };

/** What `CustomersService.findOrCreate` needs (spec 0014 AC-1). */
export interface FindOrCreateInput {
  /** The caller's `EgyptianPhone.parse` result, or null when its text did not parse. */
  phone: NormalizedPhone | null;
  /** The outside id, when the caller has one. */
  channelCustomer: ChannelCustomerRef | null;
  /** The customer's name; written only when the customer has none. */
  name: string | null;
  /** When the caller saw the customer (the order's `placed_at`, the webhook's time). */
  seenAt: Date;
  /**
   * Whether the caller vouches for the phone (default true). A Shopify customer webhook passes
   * false (owner ruling L1, option A): an unverified phone never links to an existing customer
   * and is never added to one. See `findOrCreate` for what each rule then answers and writes.
   */
  phoneVerified?: boolean;
}

/** What `findOrCreate` answers: the canonical customer (null for `no_phone`) and what it did. */
export interface FindOrCreateResult {
  /** The canonical customer, or null when nothing could be linked. */
  customerId: string | null;
  /** The rule that applied. */
  outcome: FindOrCreateOutcome;
}

interface Located {
  /** The row of the phone or channel id. */
  rowId: string;
  /** The canonical customer behind the row's customer (one hop of `merged_into_id`). */
  customerId: string;
}

interface LocatedRow extends Record<string, unknown> {
  row_id: string;
  customer_id: string;
}

const instant = (date: Date): string => date.toISOString();

async function locatePhone(tx: Transaction, e164: string): Promise<Located | null> {
  const { rows } = await tx.execute<LocatedRow>(sql`
    SELECT p.id AS row_id, coalesce(c.merged_into_id, c.id) AS customer_id
    FROM customer_phones p JOIN customers c ON c.id = p.customer_id
    WHERE p.phone_e164 = ${e164}`);
  const row = rows[0];
  return row ? { rowId: row.row_id, customerId: row.customer_id } : null;
}

/** The connection or channel that issued the id, as the one issuer column pair. */
const issuerOf = (
  ref: ChannelCustomerRef,
): { connectionId: string | null; channelId: string | null } =>
  ref.kind === 'shopify_customer'
    ? { connectionId: ref.connectionId, channelId: null }
    : { connectionId: null, channelId: ref.channelId };

async function locateExternalId(tx: Transaction, ref: ChannelCustomerRef): Promise<Located | null> {
  // Both predicates are plain equality or IS NULL, so the unique key (tenant, kind, connection,
  // channel, external id) serves the lookup; the issuer is one of the two columns, never both.
  const issuer =
    ref.kind === 'shopify_customer'
      ? sql`e.connection_id = ${ref.connectionId}::uuid AND e.channel_id IS NULL`
      : sql`e.channel_id = ${ref.channelId}::uuid AND e.connection_id IS NULL`;
  const { rows } = await tx.execute<LocatedRow>(sql`
    SELECT e.id AS row_id, coalesce(c.merged_into_id, c.id) AS customer_id
    FROM customer_external_ids e JOIN customers c ON c.id = e.customer_id
    WHERE e.kind = ${ref.kind}::customer_external_id_kind
      AND ${issuer}
      AND e.external_id = ${ref.externalId}`);
  const row = rows[0];
  return row ? { rowId: row.row_id, customerId: row.customer_id } : null;
}

async function insertExternalId(
  tx: Transaction,
  customerId: string,
  ref: ChannelCustomerRef,
): Promise<string | null> {
  const { connectionId, channelId } = issuerOf(ref);
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO customer_external_ids (customer_id, kind, connection_id, channel_id, external_id)
    VALUES (${customerId}::uuid, ${ref.kind}::customer_external_id_kind,
            ${connectionId}::uuid, ${channelId}::uuid, ${ref.externalId})
    ON CONFLICT ON CONSTRAINT customer_external_ids_issuer_unique DO NOTHING
    RETURNING id`);
  return rows[0]?.id ?? null;
}

async function insertPhone(
  tx: Transaction,
  customerId: string,
  phone: NormalizedPhone,
  primary: boolean,
  seenAt: Date,
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary, first_seen_at, last_seen_at)
    VALUES (${customerId}::uuid, ${phone.e164}, ${phone.kind}::customer_phone_kind, ${primary},
            ${instant(seenAt)}::timestamptz, ${instant(seenAt)}::timestamptz)
    ON CONFLICT ON CONSTRAINT customer_phones_phone_unique DO NOTHING
    RETURNING id`);
  return rows[0]?.id ?? null;
}

/** Opens at most one suggestion for the pair (a pair has one row ever, so a dismissed pair stays closed). */
async function suggestChannelConflict(
  tx: Transaction,
  a: string,
  b: string,
  evidenceExternalIdId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO customer_merge_suggestions
      (customer_low_id, customer_high_id, reason, evidence_external_id_id)
    VALUES (LEAST(${a}::uuid, ${b}::uuid), GREATEST(${a}::uuid, ${b}::uuid),
            'channel_id_conflict', ${evidenceExternalIdId}::uuid)
    ON CONFLICT ON CONSTRAINT customer_merge_suggestions_pair_unique DO NOTHING`);
}

/**
 * Writes the name only when the customer's is empty, and widens the phone's seen range: the last
 * seen time only forward, the first seen time only backward (an older order replayed later still
 * says when the phone was first seen).
 */
async function touch(
  tx: Transaction,
  customerId: string,
  name: string | null,
  phoneRowId: string | null,
  seenAt: Date,
): Promise<void> {
  if (name !== null) {
    await tx.execute(sql`
      UPDATE customers SET name = ${name}, updated_at = now()
      WHERE id = ${customerId}::uuid AND (name IS NULL OR name = '')`);
  }
  if (phoneRowId !== null) {
    await tx.execute(sql`
      UPDATE customer_phones
      SET last_seen_at = greatest(last_seen_at, ${instant(seenAt)}::timestamptz),
          first_seen_at = least(first_seen_at, ${instant(seenAt)}::timestamptz)
      WHERE id = ${phoneRowId}::uuid
        AND (last_seen_at < ${instant(seenAt)}::timestamptz
             OR first_seen_at > ${instant(seenAt)}::timestamptz)`);
  }
}

/**
 * A customer name ready to store: invisible format characters (`\p{Cf}`: the direction marks and
 * isolates, zero width characters) removed, then trimmed, and null when nothing is left. A name
 * pasted from a chat can carry such marks; kept, they would make one person's name differ from
 * itself, hide text in a list, or flip the order of a printed label.
 */
export function cleanCustomerName(name: string | null): string | null {
  if (name === null) return null;
  const cleaned = name.replace(/\p{Cf}/gu, '').trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * The rules of spec 0014 AC-1, in the caller's transaction: finds the canonical customer behind a
 * normalized phone and an optional outside id, or creates one, never moving a phone or an id
 * between customers. It takes the phone lock, then the channel id lock, always in that order, so
 * twenty parallel calls for one new phone create one customer and a replay writes nothing new.
 *
 * With `phoneVerified: false` (owner ruling L1): rule (b) (phone known, channel id unknown) writes
 * nothing and answers `{ customerId: null, outcome: 'unverified_phone' }`; rule (c) (channel id
 * known, phone new) adds no phone, still fills an empty name, and answers the channel id's
 * customer with `unverified_phone`; (a), (d), (e), (f) are unchanged.
 *
 * It must never open its own transaction, never see raw phone text, and never write a name over
 * an existing one. An empty outside id throws `INVALID_CHANNEL_CUSTOMER`.
 *
 * Call it once per transaction. A transaction that links several phones holds each phone lock
 * until it ends, so two such transactions can wait on each other in a circle; when one must link
 * several, take them in ascending order of `phone.e164`.
 */
export async function findOrCreate(
  tx: Transaction,
  input: FindOrCreateInput,
): Promise<FindOrCreateResult> {
  const { phone, seenAt } = input;
  const phoneVerified = input.phoneVerified ?? true;
  const channel =
    input.channelCustomer === null
      ? null
      : { ...input.channelCustomer, externalId: input.channelCustomer.externalId.trim() };
  if (channel !== null && channel.externalId === '') {
    throw new CustomersError('INVALID_CHANNEL_CUSTOMER', 'A channel customer id is empty');
  }
  const name = cleanCustomerName(input.name);
  if (phone === null && channel === null) return { customerId: null, outcome: 'no_phone' };

  if (phone !== null) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${CUSTOMER_PHONE_LOCK}::int, hashtext(${phone.e164}))`,
    );
  }
  if (channel !== null) {
    const { connectionId, channelId } = issuerOf(channel);
    const key = `${channel.kind}|${connectionId ?? channelId}|${channel.externalId}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${CUSTOMER_EXTERNAL_ID_LOCK}::int, hashtext(${key}))`,
    );
  }

  const byPhone = phone === null ? null : await locatePhone(tx, phone.e164);
  const byChannel = channel === null ? null : await locateExternalId(tx, channel);

  if (phone !== null && byPhone !== null) {
    // Rules (a), (b), (d): the phone is the key.
    let outcome: FindOrCreateOutcome = 'matched';
    if (channel !== null) {
      if (byChannel === null) {
        // Rule (b) under an unverified phone: the phone proves nothing, so link nothing, write nothing.
        if (!phoneVerified) return { customerId: null, outcome: 'unverified_phone' };
        await insertExternalId(tx, byPhone.customerId, channel);
      } else if (byChannel.customerId !== byPhone.customerId) {
        await suggestChannelConflict(tx, byPhone.customerId, byChannel.customerId, byChannel.rowId);
        outcome = 'matched_with_conflict';
      }
    }
    await touch(tx, byPhone.customerId, name, byPhone.rowId, seenAt);
    return { customerId: byPhone.customerId, outcome };
  }

  if (byChannel !== null) {
    // Rule (c): the channel id is known, the phone is new (or the caller has none).
    // Unverified: no phone is attached; the name rule (only when empty) still applies, it writes no phone.
    if (phone !== null && phoneVerified) {
      await insertPhone(tx, byChannel.customerId, phone, false, seenAt);
    }
    await touch(tx, byChannel.customerId, name, null, seenAt);
    return {
      customerId: byChannel.customerId,
      outcome: phone !== null && !phoneVerified ? 'unverified_phone' : 'matched_by_channel_id',
    };
  }

  if (phone === null) return { customerId: null, outcome: 'no_phone' };

  // Rule (e): neither is known, so one new customer with this phone as primary.
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO customers (name) VALUES (${name}) RETURNING id`);
  const created = rows[0]?.id;
  if (created === undefined) throw new Error('The customer insert returned no row');
  // Under the phone lock a brand new customer's phone cannot already exist; a null here means a
  // writer skipped the lock, and the whole call must fail rather than leave a customer without a phone.
  if ((await insertPhone(tx, created, phone, true, seenAt)) === null) {
    throw new Error('The phone of a new customer was taken while its lock was held');
  }
  if (channel !== null) await insertExternalId(tx, created, channel);
  return { customerId: created, outcome: 'created' };
}
