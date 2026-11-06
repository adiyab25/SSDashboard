import { sql, type SQL } from 'drizzle-orm';
import { type AnyPgColumn, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Bilingual text, `{ "en": ..., "ar": ... }`. At least one language is enforced by the Zod contract. */
export type LocalizedText = { en?: string; ar?: string } & Record<string, string | undefined>;

/** Time ordered uuid primary key (PostgreSQL 18 `uuidv7()`). */
export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

/**
 * The tenant every row belongs to (spec 0002, A1). The database fills it from the `ssd.tenant_id`
 * setting that `migrate` sets on the database, so no writer can forget it. Without the setting an
 * insert fails loudly. Every table carries it, and it leads every key that holds a non uuid column.
 * Never pass a value for it from application code.
 */
export const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(sql`current_setting('ssd.tenant_id')::uuid`);

/** An amount in EGP, `numeric(14,2)`. Drizzle returns it as a string; `Money` parses it. */
export const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/** A cost per base unit, `numeric(14,4)`. */
export const unitCost = (name: string) => numeric(name, { precision: 14, scale: 4 });

/** A tax rate in percent, `numeric(5,2)` (14.00 means 14%). */
export const taxRate = (name: string) => numeric(name, { precision: 5, scale: 2 });

/** Creation timestamp, set by the database and never changed. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Last change timestamp, refreshed by Drizzle on every update through the ORM. */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Master data is archived, never deleted once referenced. */
export const archivedAt = () => timestamp('archived_at', { withTimezone: true });

/**
 * The check body for a reason, outcome, or account code column: null, or a lower case code of at
 * most 64 characters (`edit_removal`, `not_yet_matched`, `confirmation.call`). A reason is a code,
 * never a typed note: a note would be personal data kept for ever on an append only row. Never
 * use it for free text columns.
 */
export const reasonCodeShape = (column: AnyPgColumn): SQL =>
  sql`${column} IS NULL OR ${column} ~ '^[a-z][a-z0-9_.]{0,63}$'`;
