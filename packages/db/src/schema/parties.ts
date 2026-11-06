import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { archivedAt, createdAt, id, tenantId, updatedAt } from './columns.js';

/** Suppliers, factories, consignment partners, and wholesale customers. One party can hold several roles; end customers are `customers`, not parties. */
export const parties = pgTable(
  'parties',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    taxId: text('tax_id'),
    isSupplier: boolean('is_supplier').notNull().default(false),
    isConsignmentPartner: boolean('is_consignment_partner').notNull().default(false),
    isWholesaleCustomer: boolean('is_wholesale_customer').notNull().default(false),
    isFactory: boolean('is_factory').notNull().default(false),
    /** `{ phone, email }` */
    contact: jsonb('contact').$type<{ phone?: string; email?: string }>().notNull().default({}),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    unique('parties_code_unique').on(t.tenantId, t.code),
    check(
      'parties_has_a_role',
      sql`${t.isSupplier} OR ${t.isFactory} OR ${t.isConsignmentPartner} OR ${t.isWholesaleCustomer}`,
    ),
  ],
);
