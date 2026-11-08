import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { channels } from './channels.js';
import { createdAt, id, reasonCodeShape, tenantId, updatedAt } from './columns.js';
import { connections } from './connectors.js';

// The customers module (spec 0002, customers child): a customer is a normalized phone number.
// Merging never rewrites another module's rows. Only the customers module writes these tables;
// `customer_merges` is append only (trigger and revoke in the rules migration).

/** Why a customer is flagged. `returner` is the scope's repeat returner flag. */
export const customerRiskFlag = pgEnum('customer_risk_flag', [
  'returner',
  'refuser',
  'fake',
  'abusive',
]);

/** Who set a risk flag: a blacklist import, a person, or a rule. */
export const customerRiskFlagSource = pgEnum('customer_risk_flag_source', [
  'blacklist_import',
  'manual',
  'rule',
]);

/**
 * An end customer. `name` and `riskFlagNote` are personal data. A merged customer points at its
 * survivor through `mergedIntoId`, one hop deep; a flag always carries its source.
 */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    tenantId: tenantId(),
    /** A proper name, not translated. Personal data. */
    name: text('name'),
    mergedIntoId: uuid('merged_into_id'),
    riskFlag: customerRiskFlag('risk_flag'),
    riskFlagSource: customerRiskFlagSource('risk_flag_source'),
    /** Free text: personal data, redacted from logs. */
    riskFlagNote: text('risk_flag_note'),
    /** When the flag was set (spec 0014); null exactly when there is no flag. */
    riskFlagSetAt: timestamp('risk_flag_set_at', { withTimezone: true }),
    /** The person who set a `manual` flag; null for an import or rule flag. */
    riskFlagSetBy: uuid('risk_flag_set_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.mergedIntoId], foreignColumns: [t.id] }).onDelete('restrict'),
    index('customers_merged_into_idx')
      .on(t.mergedIntoId)
      .where(sql`${t.mergedIntoId} IS NOT NULL`),
    check('customers_not_merged_into_self', sql`${t.mergedIntoId} <> ${t.id}`),
    check(
      'customers_risk_flag_has_source',
      sql`(${t.riskFlag} IS NULL) = (${t.riskFlagSource} IS NULL)`,
    ),
    check(
      'customers_risk_flag_has_set_at',
      sql`(${t.riskFlag} IS NULL) = (${t.riskFlagSetAt} IS NULL)`,
    ),
    check(
      'customers_risk_flag_set_by_is_manual',
      sql`${t.riskFlagSetBy} IS NULL OR ${t.riskFlagSource} = 'manual'`,
    ),
    index('customers_risk_flag_set_by_idx')
      .on(t.riskFlagSetBy)
      .where(sql`${t.riskFlagSetBy} IS NOT NULL`),
    // The flagged list (spec 0014 AC-5): canonical flagged customers, most recently flagged first.
    index('customers_flagged_idx')
      .on(t.riskFlagSetAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.riskFlag} IS NOT NULL AND ${t.mergedIntoId} IS NULL`),
    // The name search (spec 0014 AC-5): `ILIKE '%text%'` through the trigram index.
    index('customers_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
  ],
);

/** What a phone number is, as `EgyptianPhone.parse` reports it. */
export const customerPhoneKind = pgEnum('customer_phone_kind', ['mobile', 'landline', 'foreign']);

/**
 * A customer's phone in E.164 form (`+201001234567`). A phone belongs to one customer per tenant,
 * and a customer has at most one primary phone. Personal data.
 */
export const customerPhones = pgTable(
  'customer_phones',
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    phoneE164: text('phone_e164').notNull(),
    kind: customerPhoneKind('kind').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customer_phones_phone_unique').on(t.tenantId, t.phoneE164),
    index('customer_phones_customer_idx').on(t.customerId),
    uniqueIndex('customer_phones_one_primary_unique')
      .on(t.customerId)
      .where(sql`${t.isPrimary}`),
    check('customer_phones_e164', sql`${t.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`),
  ],
);

/** Which outside system issued a customer id. */
export const customerExternalIdKind = pgEnum('customer_external_id_kind', [
  'shopify_customer',
  'partner_reference',
  'whatsapp_contact',
]);

/**
 * A customer's id in an outside system: issued either by a connected account (one Shopify store)
 * or by a channel without a connection (a partner's own reference), never both.
 */
export const customerExternalIds = pgTable(
  'customer_external_ids',
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    kind: customerExternalIdKind('kind').notNull(),
    connectionId: uuid('connection_id').references(() => connections.id, {
      onDelete: 'restrict',
    }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'customer_external_ids_one_issuer',
      sql`num_nonnulls(${t.connectionId}, ${t.channelId}) = 1`,
    ),
    unique('customer_external_ids_issuer_unique')
      .on(t.tenantId, t.kind, t.connectionId, t.channelId, t.externalId)
      .nullsNotDistinct(),
    index('customer_external_ids_customer_idx').on(t.customerId),
    index('customer_external_ids_connection_idx').on(t.connectionId),
    index('customer_external_ids_channel_idx').on(t.channelId),
  ],
);

/** A merge of two customers, or the undo of one. */
export const customerMergeAction = pgEnum('customer_merge_action', ['merge', 'undo']);

/**
 * The append only history of merges and undos. An undo is a new row pointing at the merge it
 * undoes, and a merge is undone at most once. An insert trigger (`customer_merges_undo_matches`,
 * rules migration) refuses an undo whose target is not a merge of the same survivor and merged
 * customer. `reason` is a code (`reasonCodeShape`, security review S4), never a typed note: the row
 * is kept for ever, so a note with personal data could never be erased.
 */
export const customerMerges = pgTable(
  'customer_merges',
  {
    id: id(),
    tenantId: tenantId(),
    action: customerMergeAction('action').notNull(),
    survivorId: uuid('survivor_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    mergedId: uuid('merged_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** Customers that pointed at `mergedId` and were moved to `survivorId`, so an undo can move them back. */
    repointedIds: uuid('repointed_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    undoesMergeId: uuid('undoes_merge_id'),
    reason: text('reason'),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.undoesMergeId], foreignColumns: [t.id] }).onDelete('restrict'),
    unique('customer_merges_undoes_merge_unique').on(t.undoesMergeId),
    check(
      'customer_merges_undo_names_merge',
      sql`(${t.action} = 'undo') = (${t.undoesMergeId} IS NOT NULL)`,
    ),
    check('customer_merges_two_customers', sql`${t.survivorId} <> ${t.mergedId}`),
    // Security review S4 (feature 4 close): a code, never a note, so no personal data is kept for ever.
    check('customer_merges_reason_shape', reasonCodeShape(t.reason)),
    index('customer_merges_survivor_idx').on(t.survivorId),
    index('customer_merges_merged_idx').on(t.mergedId),
    index('customer_merges_actor_idx').on(t.actorId),
  ],
);

/** Why two customers are suggested for a merge. */
export const mergeSuggestionReason = pgEnum('merge_suggestion_reason', [
  'channel_id_conflict',
  'second_phone_conflict',
]);

/** Where a merge suggestion stands: waiting for a person, merged, or dismissed. */
export const mergeSuggestionStatus = pgEnum('merge_suggestion_status', [
  'open',
  'applied',
  'dismissed',
]);

/**
 * A pair of customers that are probably one person (spec 0014 AC-9). One row per pair, ever: a
 * dismissed pair is never suggested again. The pair is stored as the two canonical ids at opening
 * time, `customerLowId` below `customerHighId`. Mutable (status moves once); carries ids and codes
 * only, never a name or phone.
 */
export const customerMergeSuggestions = pgTable(
  'customer_merge_suggestions',
  {
    id: id(),
    tenantId: tenantId(),
    customerLowId: uuid('customer_low_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    customerHighId: uuid('customer_high_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    reason: mergeSuggestionReason('reason').notNull(),
    evidenceExternalIdId: uuid('evidence_external_id_id').references(() => customerExternalIds.id, {
      onDelete: 'restrict',
    }),
    evidencePhoneId: uuid('evidence_phone_id').references(() => customerPhones.id, {
      onDelete: 'restrict',
    }),
    status: mergeSuggestionStatus('status').notNull().default('open'),
    mergeId: uuid('merge_id').references(() => customerMerges.id, { onDelete: 'restrict' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** A reason code for a dismissal (`reasonCodeShape`), never a note. */
    dismissReason: text('dismiss_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('customer_merge_suggestions_pair_unique').on(t.customerLowId, t.customerHighId),
    check('customer_merge_suggestions_ordered', sql`${t.customerLowId} < ${t.customerHighId}`),
    check(
      'customer_merge_suggestions_channel_evidence',
      sql`(${t.reason} = 'channel_id_conflict') = (${t.evidenceExternalIdId} IS NOT NULL)`,
    ),
    check(
      'customer_merge_suggestions_phone_evidence',
      sql`(${t.reason} = 'second_phone_conflict') = (${t.evidencePhoneId} IS NOT NULL)`,
    ),
    check(
      'customer_merge_suggestions_applied_has_merge',
      sql`(${t.status} = 'applied') = (${t.mergeId} IS NOT NULL)`,
    ),
    check(
      'customer_merge_suggestions_open_is_undecided',
      sql`(${t.status} = 'open') = (${t.decidedAt} IS NULL)`,
    ),
    check(
      'customer_merge_suggestions_dismiss_reason',
      sql`(${t.dismissReason} IS NULL OR ${t.status} = 'dismissed') AND (${reasonCodeShape(t.dismissReason)})`,
    ),
    index('customer_merge_suggestions_open_idx')
      .on(t.createdAt, t.id)
      .where(sql`${t.status} = 'open'`),
    index('customer_merge_suggestions_high_idx').on(t.customerHighId),
    index('customer_merge_suggestions_evidence_external_idx')
      .on(t.evidenceExternalIdId)
      .where(sql`${t.evidenceExternalIdId} IS NOT NULL`),
    index('customer_merge_suggestions_evidence_phone_idx')
      .on(t.evidencePhoneId)
      .where(sql`${t.evidencePhoneId} IS NOT NULL`),
    index('customer_merge_suggestions_merge_idx')
      .on(t.mergeId)
      .where(sql`${t.mergeId} IS NOT NULL`),
    index('customer_merge_suggestions_decided_by_idx')
      .on(t.decidedBy)
      .where(sql`${t.decidedBy} IS NOT NULL`),
  ],
);
