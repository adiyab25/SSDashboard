import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { productVariants } from './catalog.js';
import { stores } from './channels.js';
import {
  archivedAt,
  createdAt,
  id,
  money,
  reasonCodeShape,
  tenantId,
  updatedAt,
  type LocalizedText,
} from './columns.js';
import { connections } from './connectors.js';
import { settlementOwnerType } from './locations.js';
import { orderLines, orders } from './orders.js';
import { parties } from './parties.js';

// The settlement module (spec 0002, settlement child): money held by a carrier, a consignment
// partner, or a gateway, settled per account through periods, statements, lines, and match rows.
// Only the settlement module writes these tables. Statements, lines, match rows, and period events
// are append only (triggers and revoke in the rules migration, 0002), which also adds the period
// overlap exclusion (Drizzle cannot express it) and the `settlement_periods_closed_dates_fixed`
// trigger. A line's period is derived from `occurred_on`, never stored.

/** Whether a settlement period is open; always the result of its latest event. */
export const settlementPeriodStatus = pgEnum('settlement_period_status', ['open', 'closed']);

/** What a period event did. */
export const settlementPeriodAction = pgEnum('settlement_period_action', ['closed', 'revoked']);

/** Who wrote a period event. */
export const settlementPeriodActorType = pgEnum('settlement_period_actor_type', ['person', 'rule']);

/** How a statement reached the brand. `count` is a count at a partner location: evidence, not money. */
export const settlementStatementKind = pgEnum('settlement_statement_kind', [
  'carrier_file',
  'carrier_api',
  'partner_file',
  'partner_upload',
  'partner_api',
  'count',
]);

/** What a statement line is. Positive amounts are owed to the brand by the account owner. */
export const settlementLineKind = pgEnum('settlement_line_kind', [
  'cod_collected',
  'cod_fee',
  'shipping_fee',
  'opening_package_fee',
  'other_fee',
  'fee_vat',
  'customer_refund',
  'compensation',
  'deposit',
  'consignment_sale',
  'consignment_return',
  'defective_return_credit',
  'missing_piece_charge',
  'partner_payment',
  'adjustment',
]);

/**
 * What one match row says about a line. `accounted` is terminal, except that a line of a superseded
 * statement may still be `cleared` with the reason `superseded` (domain review D1); `cleared` is
 * only for superseded statements.
 */
export const settlementMatchResult = pgEnum('settlement_match_result', [
  'matched',
  'accounted',
  'unmatched',
  'cleared',
]);

/** Who wrote a match row. */
export const settlementMatchedByType = pgEnum('settlement_matched_by_type', ['rule', 'person']);

/**
 * One account money is settled through: a carrier or gateway connection, or a consignment
 * partner. An owner has at most one live (not archived) account, and an account's owner is fixed
 * for life (trigger `settlement_accounts_owner_fixed`). Archived, never deleted.
 */
export const settlementAccounts = pgTable(
  'settlement_accounts',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    ownerType: settlementOwnerType('owner_type').notNull(),
    /** Carrier and gateway accounts: the connected account. */
    ownerConnectionId: uuid('owner_connection_id').references(() => connections.id, {
      onDelete: 'restrict',
    }),
    /** Consignment partner accounts: the partner. */
    ownerPartyId: uuid('owner_party_id').references(() => parties.id, { onDelete: 'restrict' }),
    archivedAt: archivedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('settlement_accounts_code_unique').on(t.tenantId, t.code),
    check(
      'settlement_accounts_owner_matches_type',
      sql`CASE ${t.ownerType}
            WHEN 'consignment_partner' THEN ${t.ownerPartyId} IS NOT NULL AND ${t.ownerConnectionId} IS NULL
            ELSE ${t.ownerConnectionId} IS NOT NULL AND ${t.ownerPartyId} IS NULL
          END`,
    ),
    uniqueIndex('settlement_accounts_live_connection_unique')
      .on(t.tenantId, t.ownerConnectionId)
      .where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex('settlement_accounts_live_party_unique')
      .on(t.tenantId, t.ownerPartyId)
      .where(sql`${t.archivedAt} IS NULL`),
    index('settlement_accounts_connection_idx').on(t.ownerConnectionId),
    index('settlement_accounts_party_idx').on(t.ownerPartyId),
  ],
);

/**
 * A date range an account settles. Periods of one account never overlap (exclusion constraint
 * `settlement_periods_no_overlap`, rules migration), and a closed period's dates cannot change
 * (`PeriodClosed`). `status` is a stored copy of the latest event's result: an event insert sets
 * it, and an update that disagrees with the latest event is refused (security review MJ2). Its
 * account is fixed for life, and a period is never deleted, by any role (rules migration).
 */
export const settlementPeriods = pgTable(
  'settlement_periods',
  {
    id: id(),
    tenantId: tenantId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => settlementAccounts.id, { onDelete: 'restrict' }),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: settlementPeriodStatus('status').notNull().default('open'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('settlement_periods_dates_in_order', sql`${t.startsOn} <= ${t.endsOn}`),
    index('settlement_periods_account_starts_idx').on(t.accountId, t.startsOn.desc().nullsFirst()),
  ],
);

/**
 * The append only history of a period's closes and revokes. A close carries its evidence; a
 * revoke carries a reason. The period's status is always the latest event's result.
 */
export const settlementPeriodEvents = pgTable(
  'settlement_period_events',
  {
    id: id(),
    tenantId: tenantId(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => settlementPeriods.id, { onDelete: 'restrict' }),
    action: settlementPeriodAction('action').notNull(),
    /** A close: the statement total, the matched plus accounted total, the checksum, and how it closed. */
    evidence: jsonb('evidence'),
    /** Required on a revoke: a code (`reasonCodeShape`, security review S4), never a typed note. */
    reason: text('reason'),
    actorType: settlementPeriodActorType('actor_type').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('settlement_period_events_period_recorded_idx').on(t.periodId, t.recordedAt),
    index('settlement_period_events_actor_idx').on(t.actorId),
    check(
      'settlement_period_events_revoke_has_reason',
      sql`${t.action} <> 'revoked' OR (${t.reason} IS NOT NULL AND btrim(${t.reason}) <> '')`,
    ),
    // Security review n1: a close always records its evidence.
    check(
      'settlement_period_events_close_has_evidence',
      sql`${t.action} <> 'closed' OR ${t.evidence} IS NOT NULL`,
    ),
    check(
      'settlement_period_events_person_has_actor',
      sql`${t.actorType} <> 'person' OR ${t.actorId} IS NOT NULL`,
    ),
    check('settlement_period_events_reason_shape', reasonCodeShape(t.reason)),
  ],
);

/**
 * One statement from a third party, as received: its reference, the days it speaks for (a range
 * with no lines is the partner's explicit "no sales"), its file, and its own totals as evidence.
 * Append only: a correction is a new statement that supersedes this one, at most once.
 */
export const settlementStatements = pgTable(
  'settlement_statements',
  {
    id: id(),
    tenantId: tenantId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => settlementAccounts.id, { onDelete: 'restrict' }),
    kind: settlementStatementKind('kind').notNull(),
    /** A cash cycle id, a file name, or a partner's statement number. */
    externalReference: text('external_reference').notNull(),
    coversFrom: date('covers_from'),
    coversTo: date('covers_to'),
    /** An uploaded file in object storage. */
    objectKey: text('object_key'),
    sha256: text('sha256'),
    /** The third party's own total. */
    statementTotal: money('statement_total'),
    /** The partner's own unit total. */
    statementUnits: integer('statement_units'),
    depositedAmount: money('deposited_amount'),
    depositedOn: date('deposited_on'),
    supersedesStatementId: uuid('supersedes_statement_id'),
    importedBy: uuid('imported_by').references(() => users.id, { onDelete: 'restrict' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A correction supersedes a statement of its own account (security review m4).
    foreignKey({
      columns: [t.supersedesStatementId, t.accountId],
      foreignColumns: [t.id, t.accountId],
    }).onDelete('restrict'),
    unique('settlement_statements_reference_unique')
      .on(t.tenantId, t.accountId, t.externalReference, t.sha256)
      .nullsNotDistinct(),
    // A statement is superseded at most once.
    unique('settlement_statements_supersedes_unique').on(t.supersedesStatementId),
    // The target of the lines' composite key, so a line always sits on a statement of its account.
    unique('settlement_statements_id_account_unique').on(t.id, t.accountId),
    check(
      'settlement_statements_not_superseding_self',
      sql`${t.supersedesStatementId} IS DISTINCT FROM ${t.id}`,
    ),
    check(
      'settlement_statements_covers_in_order',
      sql`${t.coversFrom} IS NULL OR ${t.coversTo} IS NULL OR ${t.coversFrom} <= ${t.coversTo}`,
    ),
    index('settlement_statements_account_received_idx').on(
      t.accountId,
      t.receivedAt.desc().nullsFirst(),
    ),
    index('settlement_statements_account_covers_idx').on(t.accountId, t.coversFrom, t.coversTo),
    index('settlement_statements_imported_by_idx').on(t.importedBy),
    // Foreign key index: the (supersedes_statement_id, account_id) key (spec 0002 item 19).
    index('settlement_statements_supersedes_account_idx')
      .on(t.supersedesStatementId, t.accountId)
      .where(sql`${t.supersedesStatementId} IS NOT NULL`),
  ],
);

/**
 * One line of a statement: the third party's fact, stored as given and never edited. Its period is
 * the account's period whose dates hold `occurredOn` (never stored). Line references are unique
 * per statement, so a corrected statement may number its lines 1 to n again.
 */
export const settlementLines = pgTable(
  'settlement_lines',
  {
    id: id(),
    tenantId: tenantId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => settlementAccounts.id, { onDelete: 'restrict' }),
    statementId: uuid('statement_id').notNull(),
    lineKind: settlementLineKind('line_kind').notNull(),
    /** The carrier's own fee name: set on every `other_fee` line and on no other kind (two checks). */
    feeCode: text('fee_code'),
    /** Signed: positive is owed to the brand by the account owner. */
    amount: money('amount').notNull(),
    /** The third party's line identity within its statement. */
    externalLineRef: text('external_line_ref').notNull(),
    /** Carrier: the cash cycle's deposit date; partner: the reported sale or return day. Decides the period. */
    occurredOn: date('occurred_on').notNull(),
    trackingNumber: text('tracking_number'),
    businessReference: text('business_reference'),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    partnerCode: text('partner_code'),
    /** The statement's own wording (an `adjustment`, a partner line), at most 500 characters; redacted in logs. */
    partnerText: text('partner_text'),
    partnerOrderRef: text('partner_order_ref'),
    /** Negative for a return. */
    quantity: integer('quantity'),
    /** The consignment price. */
    unitPrice: money('unit_price'),
    grossAmount: money('gross_amount'),
    discountAmount: money('discount_amount'),
    netAmount: money('net_amount'),
    amountsIncludeVat: boolean('amounts_include_vat'),
  },
  (t) => [
    foreignKey({
      columns: [t.statementId, t.accountId],
      foreignColumns: [settlementStatements.id, settlementStatements.accountId],
    }).onDelete('restrict'),
    // Domain review D6 (feature 4 close): `fee_code` is part of a line's identity, so two different
    // `other_fee` fees on one delivery in one cash cycle are two lines. Null for every other kind.
    unique('settlement_lines_statement_ref_unique')
      .on(t.tenantId, t.accountId, t.statementId, t.externalLineRef, t.feeCode)
      .nullsNotDistinct(),
    index('settlement_lines_tracking_idx').on(t.trackingNumber),
    // Leads with the (statement_id, account_id) foreign key, so it also serves statement_id alone.
    index('settlement_lines_statement_idx').on(t.statementId, t.accountId),
    index('settlement_lines_account_occurred_idx').on(t.accountId, t.occurredOn),
    index('settlement_lines_store_idx').on(t.storeId),
    check(
      'settlement_lines_other_fee_has_code',
      sql`${t.lineKind} <> 'other_fee' OR ${t.feeCode} IS NOT NULL`,
    ),
    // Domain review, fix re-check: the reverse, so a fee name can never split the dedupe key of
    // any other kind (two `cod_collected` lines under one reference with different fee names).
    check(
      'settlement_lines_fee_code_only_on_other_fee',
      sql`${t.lineKind} = 'other_fee' OR ${t.feeCode} IS NULL`,
    ),
    // Security review S4: the partner's wording stays bounded (it is kept for ever and redacted in logs).
    check('settlement_lines_partner_text_length', sql`char_length(${t.partnerText}) <= 500`),
  ],
);

/**
 * The append only matching history of a line; its latest row is its state (none means
 * `unmatched`, `not_yet_matched`). A new row supersedes the previous one, at most once.
 */
export const settlementLineMatches = pgTable(
  'settlement_line_matches',
  {
    id: id(),
    tenantId: tenantId(),
    lineId: uuid('line_id')
      .notNull()
      .references(() => settlementLines.id, { onDelete: 'restrict' }),
    result: settlementMatchResult('result').notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    /** Always with its `orderId`: the composite key keeps a line on its own order. */
    orderLineId: uuid('order_line_id'),
    /** Partner lines: from the channel code mapping at match time. */
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'restrict' }),
    /** Set exactly on `accounted`: `payment_received`, `carrier_deposit`, and the codes later features add. */
    accountCode: text('account_code'),
    /** The refund an accounted line settles; its foreign key arrives with feature 35. */
    refundId: uuid('refund_id'),
    /** At most 500 characters; redacted in logs (security review S4). */
    paymentReference: text('payment_reference'),
    /** Required on `unmatched` and `cleared`. */
    reasonCode: text('reason_code'),
    matchedByType: settlementMatchedByType('matched_by_type').notNull(),
    matchedBy: uuid('matched_by').references(() => users.id, { onDelete: 'restrict' }),
    ruleCode: text('rule_code'),
    supersedesMatchId: uuid('supersedes_match_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One chain per line (security review m4, n2): a row supersedes a row of its own line, each
    // row is superseded at most once (which serializes concurrent matchers), and a line has one
    // first row. The insert trigger `settlement_line_matches_extends_chain` (rules migration) keeps
    // every new row on the current head and refuses to supersede an `accounted` row, except with a
    // `cleared` row, reason `superseded`, once the line's statement is superseded (domain review D1).
    unique('settlement_line_matches_id_line_unique').on(t.id, t.lineId),
    foreignKey({
      columns: [t.supersedesMatchId, t.lineId],
      foreignColumns: [t.id, t.lineId],
    }).onDelete('restrict'),
    unique('settlement_line_matches_supersedes_unique').on(t.supersedesMatchId),
    uniqueIndex('settlement_line_matches_one_first_row_unique')
      .on(t.lineId)
      .where(sql`${t.supersedesMatchId} IS NULL`),
    foreignKey({
      columns: [t.orderLineId, t.orderId],
      foreignColumns: [orderLines.id, orderLines.orderId],
    }).onDelete('restrict'),
    index('settlement_line_matches_line_recorded_idx').on(
      t.lineId,
      t.recordedAt.desc().nullsFirst(),
    ),
    index('settlement_line_matches_order_idx').on(t.orderId),
    // Foreign key indexes: the (order_line_id, order_id) and (supersedes_match_id, line_id) keys.
    index('settlement_line_matches_order_line_idx')
      .on(t.orderLineId, t.orderId)
      .where(sql`${t.orderLineId} IS NOT NULL`),
    index('settlement_line_matches_supersedes_line_idx')
      .on(t.supersedesMatchId, t.lineId)
      .where(sql`${t.supersedesMatchId} IS NOT NULL`),
    index('settlement_line_matches_variant_idx').on(t.variantId),
    index('settlement_line_matches_matched_by_idx').on(t.matchedBy),
    index('settlement_line_matches_refund_idx').on(t.refundId),
    check(
      'settlement_line_matches_line_needs_order',
      sql`${t.orderLineId} IS NULL OR ${t.orderId} IS NOT NULL`,
    ),
    check(
      'settlement_line_matches_matched_has_target',
      sql`${t.result} <> 'matched' OR ${t.orderId} IS NOT NULL OR ${t.variantId} IS NOT NULL`,
    ),
    check(
      'settlement_line_matches_account_code_when_accounted',
      sql`(${t.result} = 'accounted') = (${t.accountCode} IS NOT NULL)`,
    ),
    check(
      'settlement_line_matches_reason_when_unmatched',
      sql`${t.result} NOT IN ('unmatched', 'cleared') OR ${t.reasonCode} IS NOT NULL`,
    ),
    check(
      'settlement_line_matches_person_has_actor',
      sql`${t.matchedByType} <> 'person' OR ${t.matchedBy} IS NOT NULL`,
    ),
    check('settlement_line_matches_reason_code_shape', reasonCodeShape(t.reasonCode)),
    check('settlement_line_matches_account_code_shape', reasonCodeShape(t.accountCode)),
    check('settlement_line_matches_rule_code_shape', reasonCodeShape(t.ruleCode)),
    check(
      'settlement_line_matches_payment_reference_length',
      sql`char_length(${t.paymentReference}) <= 500`,
    ),
  ],
);
