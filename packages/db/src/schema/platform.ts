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
import { archivedAt, id, updatedAt, type LocalizedText } from './columns.js';

/** Install settings, one row per key. Seeded by the core data model migration. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
  updatedBy: uuid('updated_by'),
});

/** Gap free document numbers: one counter per document type and year. */
export const documentCounters = pgTable(
  'document_counters',
  {
    docType: text('doc_type').notNull(),
    year: integer('year').notNull(),
    lastValue: integer('last_value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.docType, t.year] })],
);

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
    entity: text('entity').notNull(),
    key: text('key').notNull(),
    type: customFieldType('type').notNull(),
    label: jsonb('label').$type<LocalizedText>().notNull(),
    required: boolean('required').notNull().default(false),
    options: jsonb('options'),
    archivedAt: archivedAt(),
  },
  (t) => [unique('custom_field_definitions_entity_key_unique').on(t.entity, t.key)],
);
