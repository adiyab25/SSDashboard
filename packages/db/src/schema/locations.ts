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

/** What kind of place holds stock: a warehouse, a consignment showroom, goods in transit, or a virtual bucket. */
export const locationType = pgEnum('location_type', [
  'warehouse',
  'showroom',
  'transit',
  'virtual',
]);

/** A place stock is counted in. Archived rather than deleted; `allowNegative` lets postings take on-hand below zero at this location. */
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

/** Depth in the bin tree, from a whole zone down to a single bin. */
export const binLevel = pgEnum('bin_level', ['zone', 'aisle', 'shelf', 'bin']);

/** A storage position inside a location, nested by `parentId`. Code is unique per location; the `(id, location_id)` unique key lets other tables keep a bin in its row's location. */
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
