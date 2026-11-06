import { index, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { archivedAt, createdAt, id, tenantId, updatedAt, type LocalizedText } from './columns.js';
import { locations } from './locations.js';

// The channels module (spec 0002, orders child): where an order is numbered and priced (a store)
// and how it arrived (a channel). Only the channels module writes these tables.

/** What kind of store: one per Shopify connection, or an internal store for manual, landing page, and WhatsApp orders. */
export const storeKind = pgEnum('store_kind', ['shopify', 'internal']);

/**
 * Where an order is numbered and priced. An order number is unique per store, never across
 * stores (two Shopify stores both have `#1001`). Seeded with the internal store `MAIN`.
 * Archived, never deleted once an order references it.
 */
export const stores = pgTable(
  'stores',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    /** What the customer portal shows when one phone and order number match in two stores. */
    publicName: jsonb('public_name').$type<LocalizedText>().notNull(),
    kind: storeKind('kind').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [unique('stores_code_unique').on(t.tenantId, t.code)],
);

/** How an order arrived; also the key of the export rules matrix and of channel code mapping. */
export const channelKind = pgEnum('channel_kind', [
  'shopify',
  'landing_page',
  'manual',
  'whatsapp',
  'instagram',
  'consignment_partner',
  'wholesale',
]);

/**
 * How an order arrived. A partner or wholesale channel names the location it reports for.
 * Seeded with `manual`, whose default store is `MAIN`. Archived, never deleted once referenced.
 */
export const channels = pgTable(
  'channels',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    kind: channelKind('kind').notNull(),
    /** The store an order on this channel goes to when nothing else decides it. */
    defaultStoreId: uuid('default_store_id').references(() => stores.id, { onDelete: 'restrict' }),
    /** The partner or wholesale location a partner channel reports for. */
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    unique('channels_code_unique').on(t.tenantId, t.code),
    index('channels_location_idx').on(t.locationId),
    index('channels_default_store_idx').on(t.defaultStoreId),
  ],
);
