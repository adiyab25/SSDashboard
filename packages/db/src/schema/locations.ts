import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, createdAt, id, updatedAt, type LocalizedText } from './columns.js';

export const locationType = pgEnum('location_type', [
  'warehouse',
  'showroom',
  'transit',
  'virtual',
]);

export const locations = pgTable('locations', {
  id: id(),
  code: text('code').notNull().unique(),
  name: jsonb('name').$type<LocalizedText>().notNull(),
  type: locationType('type').notNull(),
  isSellable: boolean('is_sellable').notNull().default(true),
  allowNegative: boolean('allow_negative').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: archivedAt(),
});

export const binLevel = pgEnum('bin_level', ['zone', 'aisle', 'shelf', 'bin']);

export const bins = pgTable(
  'bins',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    parentId: uuid('parent_id'),
    level: binLevel('level').notNull().default('bin'),
    code: text('code').notNull(),
    isSellable: boolean('is_sellable').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id] }).onDelete('restrict'),
    unique('bins_location_code_unique').on(t.locationId, t.code),
    // Target of the (bin_id, location_id) composite keys: a bin always belongs to the row's location.
    unique('bins_id_location_unique').on(t.id, t.locationId),
    index('bins_parent_idx').on(t.parentId),
  ],
);
