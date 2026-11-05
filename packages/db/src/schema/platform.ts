import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, createdAt, id, tenantId, updatedAt, type LocalizedText } from './columns.js';

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
