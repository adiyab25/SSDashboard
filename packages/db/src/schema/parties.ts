import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { archivedAt, createdAt, id, updatedAt } from './columns.js';

/** Suppliers, factories, and customers. One party can hold several roles. */
export const parties = pgTable(
  'parties',
  {
    id: id(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    taxId: text('tax_id'),
    isSupplier: boolean('is_supplier').notNull().default(false),
    isCustomer: boolean('is_customer').notNull().default(false),
    isFactory: boolean('is_factory').notNull().default(false),
    /** `{ phone, email }` */
    contact: jsonb('contact').$type<{ phone?: string; email?: string }>().notNull().default({}),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [check('parties_has_a_role', sql`${t.isSupplier} OR ${t.isCustomer} OR ${t.isFactory}`)],
);
