import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { id, money, reasonCodeShape, tenantId } from './columns.js';
import { customers } from './customers.js';
import { orderLines, orders } from './orders.js';

// The credit module (spec 0002, customers, credit, and tasks child): the customer credit ledger,
// append only like stock. Only the credit module writes this table. The rules file (0002) adds the
// append only triggers and revoke, the operating day stamp from `effective_at`, and the two
// reversal triggers (no reversal of a reversal; a reversal mirrors its original).

/** What a credit entry records. The sign each kind carries is checked by `credit_entries_sign_by_kind`. */
export const creditEntryKind = pgEnum('credit_entry_kind', [
  'return_credit',
  'shipping_credit',
  'order_consumption',
  'refund_payout',
  'retention_bonus',
  'goodwill',
  'opening_balance',
  'inspection_reversal',
  'return_not_collected',
  'consumption_release',
  'debt_payment',
  'adjustment',
]);

/** Where an entry's value came from. `credit_only` was never cash and is never paid out. */
export const creditFunding = pgEnum('credit_funding', [
  'cod_cash',
  'gateway',
  'instapay_or_transfer',
  'credit_only',
]);

/** How a `refund_payout` reaches the customer. */
export const creditPayoutMethod = pgEnum('credit_payout_method', [
  'carrier_cash_refund',
  'gateway_refund',
  'instapay_or_transfer',
]);

/** Who posted a credit entry: a person, a named rule, a system job, or an import. */
export const creditActorType = pgEnum('credit_actor_type', [
  'person',
  'rule',
  'system_job',
  'import',
]);

// Kinds that credit the customer (a positive amount); `adjustment` may take either sign, and every
// other kind is negative. A reversal (`reverses_entry_id` set) carries the opposite sign.
const POSITIVE_KINDS = sql.raw(
  `'return_credit', 'shipping_credit', 'retention_bonus', 'goodwill', 'opening_balance', 'consumption_release', 'debt_payment'`,
);

/**
 * One signed entry of a customer's credit (positive is owed to her; negative is spent, paid out,
 * or owed back). The entries one action posts share `postingId` and `idempotencyKey`, one per
 * funding, with one customer and one request hash (trigger `credit_entries_posting_holds_together`).
 * Append only: a correction is a reversal entry (`reversesEntryId`) of the same customer with the
 * original's kind, funding, order, line, quantity, exchange, refund, and payout method and the
 * negated amount; an entry never reverses itself and a reversal is never reversed. `operatingDay`
 * is stamped from `effectiveAt` by trigger; writers never pass it. Balances are summed on read.
 */
export const creditEntries = pgTable(
  'credit_entries',
  {
    id: id(),
    tenantId: tenantId(),
    postingId: uuid('posting_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    kind: creditEntryKind('kind').notNull(),
    funding: creditFunding('funding').notNull(),
    amount: money('amount').notNull(),
    /** Set exactly on a `refund_payout`. */
    payoutMethod: creditPayoutMethod('payout_method'),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    /** Always with its `orderId`: the composite key keeps a line on its own order. */
    orderLineId: uuid('order_line_id'),
    /** Return credits: the units this posting credits, repeated on each of its entries. */
    quantity: integer('quantity'),
    /** The exchange an entry belongs to; its foreign key arrives with feature 34. */
    exchangeId: uuid('exchange_id'),
    /** The refund a payout belongs to; its foreign key arrives with feature 35. */
    refundId: uuid('refund_id'),
    reversesEntryId: uuid('reverses_entry_id'),
    reasonCode: text('reason_code').notNull(),
    actorType: creditActorType('actor_type').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    /** One per posting; a posting holds at most one entry per funding. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The hash of the posting request, the same on every entry of a posting, so a replay with other content is caught. */
    requestHash: text('request_hash').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /** The brand's Cairo day of `effectiveAt`, stamped by trigger `ssd_stamp_operating_day`; never passed by a writer. */
    operatingDay: date('operating_day').notNull(),
  },
  (t) => [
    // A reversal belongs to its original's customer (security review MJ1).
    unique('credit_entries_id_customer_unique').on(t.id, t.customerId),
    foreignKey({
      columns: [t.reversesEntryId, t.customerId],
      foreignColumns: [t.id, t.customerId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orderLineId, t.orderId],
      foreignColumns: [orderLines.id, orderLines.orderId],
    }).onDelete('restrict'),
    unique('credit_entries_posting_funding_unique').on(t.tenantId, t.idempotencyKey, t.funding),
    // An entry is reversed at most once.
    unique('credit_entries_reverses_entry_unique').on(t.reversesEntryId),
    // The balance by funding of a customer's ids.
    index('credit_entries_customer_funding_idx').on(t.customerId, t.funding, t.recordedAt),
    index('credit_entries_posting_idx').on(t.postingId),
    index('credit_entries_order_idx').on(t.orderId),
    index('credit_entries_order_line_idx').on(t.orderLineId),
    index('credit_entries_exchange_idx').on(t.exchangeId),
    index('credit_entries_refund_idx').on(t.refundId),
    index('credit_entries_actor_idx').on(t.actorId),
    index('credit_entries_operating_day_idx').on(t.operatingDay),
    check('credit_entries_amount_not_zero', sql`${t.amount} <> 0`),
    check('credit_entries_not_reversing_self', sql`${t.reversesEntryId} IS DISTINCT FROM ${t.id}`),
    check(
      'credit_entries_line_needs_order',
      sql`${t.orderLineId} IS NULL OR ${t.orderId} IS NOT NULL`,
    ),
    // Gateway money goes back through the gateway only; cash and transfer funding never does.
    check(
      'credit_entries_payout_method_matches_funding',
      sql`${t.kind} <> 'refund_payout' OR ((${t.payoutMethod} = 'gateway_refund') = (${t.funding} = 'gateway'))`,
    ),
    check(
      'credit_entries_idempotency_key_shape',
      sql`${t.idempotencyKey} ~ '^[A-Za-z0-9:_.-]{1,200}$'`,
    ),
    // Domain review M2: the sign follows the kind, inverted on a reversal.
    check(
      'credit_entries_sign_by_kind',
      sql`${t.kind} = 'adjustment'
        OR (${t.kind} IN (${POSITIVE_KINDS})) = ((${t.amount} > 0) = (${t.reversesEntryId} IS NULL))`,
    ),
    check(
      'credit_entries_payout_method_on_payout',
      sql`(${t.kind} = 'refund_payout') = (${t.payoutMethod} IS NOT NULL)`,
    ),
    check(
      'credit_entries_payout_never_credit_only',
      sql`${t.kind} <> 'refund_payout' OR ${t.funding} <> 'credit_only'`,
    ),
    check(
      'credit_entries_bonus_and_goodwill_credit_only',
      sql`${t.kind} NOT IN ('retention_bonus', 'goodwill') OR ${t.funding} = 'credit_only'`,
    ),
    check(
      'credit_entries_return_credit_has_line',
      sql`${t.kind} <> 'return_credit' OR (${t.orderLineId} IS NOT NULL AND coalesce(${t.quantity}, 0) > 0)`,
    ),
    check(
      'credit_entries_consumption_has_order',
      sql`${t.kind} NOT IN ('order_consumption', 'consumption_release') OR ${t.orderId} IS NOT NULL`,
    ),
    check(
      'credit_entries_not_collected_has_exchange',
      sql`${t.kind} <> 'return_not_collected' OR ${t.exchangeId} IS NOT NULL`,
    ),
    check(
      'credit_entries_person_has_actor',
      sql`${t.actorType} <> 'person' OR ${t.actorId} IS NOT NULL`,
    ),
    check('credit_entries_reason_code_shape', reasonCodeShape(t.reasonCode)),
  ],
);
