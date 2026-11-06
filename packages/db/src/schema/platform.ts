import { sql } from 'drizzle-orm';
import {
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
      t.effectiveFrom.desc(),
      t.recordedAt.desc(),
    ),
    index('order_cost_rules_recorded_by_idx').on(t.recordedBy),
  ],
);
