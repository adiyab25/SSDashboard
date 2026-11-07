import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import {
  archivedAt,
  createdAt,
  id,
  tenantId,
  unitCost,
  updatedAt,
  type LocalizedText,
} from './columns.js';

/** Install settings, one row per key. Seeded by the core data model migration. */
export const settings = pgTable(
  'settings',
  {
    tenantId: tenantId(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

/** Gap free document numbers: one counter per document type and year. */
export const documentCounters = pgTable(
  'document_counters',
  {
    tenantId: tenantId(),
    docType: text('doc_type').notNull(),
    year: integer('year').notNull(),
    lastValue: integer('last_value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.docType, t.year] })],
);

/** Value types a custom field can hold. */
export const customFieldType = pgEnum('custom_field_type', [
  'text',
  'number',
  'boolean',
  'date',
  'select',
]);

/** Per install custom fields on products, variants, and parties (validated from feature 46). */
export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: id(),
    tenantId: tenantId(),
    entity: text('entity').notNull(),
    key: text('key').notNull(),
    type: customFieldType('type').notNull(),
    label: jsonb('label').$type<LocalizedText>().notNull(),
    required: boolean('required').notNull().default(false),
    options: jsonb('options'),
    archivedAt: archivedAt(),
  },
  (t) => [unique('custom_field_definitions_entity_key_unique').on(t.tenantId, t.entity, t.key)],
);

/**
 * The one row that names this install: its `id` is the tenant id every other table stamps in
 * `tenant_id` (spec 0002, A1). `migrate` writes it after the first migration run, and the baseline
 * rules file adds the one row unique index on `((true))` and the check that ties `id` to the
 * `ssd.tenant_id` database setting. It has no `tenant_id` column; the schema test names it as the
 * one exception. `client_code` and `name` come from the app role name today (`ssd_<code>_app`, else
 * `dev`); feature 47 provisioning sets them properly. Never written by the api or worker.
 */
export const install = pgTable('install', {
  id: uuid('id').primaryKey(),
  clientCode: text('client_code').notNull(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

/** Which per order cost a rule sets. Percents are 0 to 100; `packaging_per_order` is EGP per order. */
export const orderCostRuleKind = pgEnum('order_cost_rule_kind', [
  'cod_fee_percent',
  'gateway_fee_percent',
  'packaging_per_order',
  'rto_unrestocked_percent',
]);

/** Whether a rule row sets a value. `not_set` is shown as "not set", never read as 0. */
export const orderCostRuleStatus = pgEnum('order_cost_rule_status', ['set', 'not_set']);

/**
 * The per order cost rules (spec 0002, catalog child, AC-32), effective dated and append only: a
 * change is a newer row (later `effective_from`, or the same day recorded later). `migrate` seeds
 * one `not_set` row per kind from the install's operating day. Read only through
 * `CostRulesService.ruleFor` in the api's platform module, which never answers 0 for a rule that
 * is not set.
 */
export const orderCostRules = pgTable(
  'order_cost_rules',
  {
    id: id(),
    tenantId: tenantId(),
    kind: orderCostRuleKind('kind').notNull(),
    status: orderCostRuleStatus('status').notNull(),
    /** A percent (0 to 100, never a fraction) or EGP for `packaging_per_order`; set exactly when `status = 'set'`. */
    value: unitCost('value'),
    effectiveFrom: date('effective_from').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    check('order_cost_rules_value_when_set', sql`(${t.status} = 'set') = (${t.value} IS NOT NULL)`),
    check('order_cost_rules_value_not_negative', sql`${t.value} >= 0`),
    check(
      'order_cost_rules_percent_at_most_100',
      sql`${t.kind} = 'packaging_per_order' OR ${t.value} <= 100`,
    ),
    index('order_cost_rules_kind_effective_idx').on(
      t.kind,
      t.effectiveFrom.desc().nullsFirst(),
      t.recordedAt.desc().nullsFirst(),
    ),
    index('order_cost_rules_recorded_by_idx').on(t.recordedBy),
  ],
);

/** How a license reached the install (spec 0009): the file at `LICENSE_FILE`, or an upload. */
export const licenseSource = pgEnum('license_source', ['file', 'upload']);

/** What started a license check (spec 0009, AC-14). */
export const licenseCheckTrigger = pgEnum('license_check_trigger', [
  'api_start',
  'worker_start',
  'daily',
  'upload',
]);

/** What a license check found (spec 0009, AC-16). Every outcome but the first two changes nothing. */
export const licenseCheckOutcome = pgEnum('license_check_outcome', [
  'valid',
  'already_recorded',
  'none_configured',
  'file_missing',
  'file_unreadable',
  'bad_format',
  'bad_signature',
  'unknown_key',
  'dev_key_in_production',
  'wrong_install',
]);

/** Where a bundle stands (spec 0009, AC-15). Warehouse never takes `wind_down`. */
export const licensePhase = pgEnum('license_phase', [
  'not_licensed',
  'active',
  'expiring',
  'grace',
  'wind_down',
  'off',
]);

/**
 * Every license this install has verified (spec 0009, AC-14, AC-20), append only: the
 * `ssd_reject_change` triggers and the app role revokes are in the license rules migration. The
 * entitlement per bundle is the union of these rows, so it never shrinks except by time. Written
 * only by `LicenseService` in the api's platform module; `envelope` is the file exactly as
 * verified, and the service counts a row only while its envelope verifies again with the image's
 * keys for this install and its term columns equal the signed payload (security M2-2), so an
 * inserted row grants nothing. `id` is stamped by the database (`licenses_1_stamp_id`). Never
 * store a signing key here.
 */
export const licenses = pgTable(
  'licenses',
  {
    id: id(),
    tenantId: tenantId(),
    /** The vendor's id from the payload. */
    licenseId: text('license_id').notNull(),
    keyId: text('key_id').notNull(),
    envelope: text('envelope').notNull(),
    /** The SHA 256 of the envelope as recorded (the file's bytes), kept as support evidence. */
    sha256: text('sha256').notNull(),
    /**
     * The SHA 256 of the signed payload bytes: one license, however its envelope is laid out, so
     * the same license saved again with other whitespace is `already_recorded` (security M2-3).
     * Not unique on purpose (security re-review R2): `LicenseService` dedupes only against rows
     * that verify, under the check lock, so a row planted with a genuine license's hash can never
     * stop that license from being recorded.
     */
    payloadSha256: text('payload_sha256').notNull(),
    clientCode: text('client_code').notNull(),
    bundles: text('bundles').array().notNull(),
    operationsExpiresOn: date('operations_expires_on'),
    /** Null means the Warehouse grant never expires (when `warehouse` is granted). */
    warehouseExpiresOn: date('warehouse_expires_on'),
    issuedOn: date('issued_on').notNull(),
    source: licenseSource('source').notNull(),
    /** Stamped by the database (`licenses_0_stamp_recorded_at`), never the writer. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    check(
      'licenses_bundles_known',
      sql`${t.bundles} <@ ARRAY['warehouse', 'operations']::text[] AND cardinality(${t.bundles}) > 0`,
    ),
    check(
      'licenses_operations_expiry',
      sql`('operations' = ANY(${t.bundles})) = (${t.operationsExpiresOn} IS NOT NULL)`,
    ),
    check(
      'licenses_warehouse_expiry',
      sql`${t.warehouseExpiresOn} IS NULL OR 'warehouse' = ANY(${t.bundles})`,
    ),
    check('licenses_envelope_size', sql`length(${t.envelope}) <= 16384`),
    check('licenses_sha256_shape', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('licenses_payload_sha256_shape', sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    index('licenses_recorded_by_idx').on(t.recordedBy),
  ],
);

/**
 * One row per license check (spec 0009, AC-14, AC-16), append only: about three a day, kept for
 * the life of the install as support evidence. The phases are the ones `bundlePhase` gave at
 * `checked_at` (from `PlatformClock`, the database's `clock_timestamp()` after the check lock);
 * they are evidence and the trigger of `LicenseChanged`, never the entitlement, which the service
 * computes live from the licenses that verify. `wind_down_ended_at` is copied forward once set,
 * so Operations stays `off` until a renewal; it can only restrict. `clock_behind` is recorded and
 * shown, never enforced. "Latest" is the highest `seq`; `id` and `seq` are stamped by the
 * database. Written only by `LicenseService`.
 */
export const licenseChecks = pgTable(
  'license_checks',
  {
    id: id(),
    /**
     * Insert order, the one "latest" (review M2 code 1, security M2-6): stamped from its sequence
     * by `license_checks_2_stamp_seq`, so neither the server clock (which `id` follows) nor a
     * writer can make an old row look latest.
     */
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    tenantId: tenantId(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    trigger: licenseCheckTrigger('trigger').notNull(),
    outcome: licenseCheckOutcome('outcome').notNull(),
    /** The SHA 256 of the file or upload checked, never its contents; null when nothing was read. */
    fileSha256: text('file_sha256'),
    licenseRowId: uuid('license_row_id').references(() => licenses.id, { onDelete: 'restrict' }),
    operationsPhase: licensePhase('operations_phase').notNull(),
    warehousePhase: licensePhase('warehouse_phase').notNull(),
    windDownEndedAt: timestamp('wind_down_ended_at', { withTimezone: true }),
    clockBehind: boolean('clock_behind').notNull().default(false),
  },
  (t) => [
    check('license_checks_warehouse_never_winds_down', sql`${t.warehousePhase} <> 'wind_down'`),
    check(
      'license_checks_file_sha256_shape',
      sql`${t.fileSha256} IS NULL OR ${t.fileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    index('license_checks_checked_at_idx').on(t.checkedAt.desc().nullsFirst()),
    index('license_checks_seq_idx').on(t.seq.desc().nullsFirst()),
    index('license_checks_license_row_idx').on(t.licenseRowId),
  ],
);
