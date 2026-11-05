import { sql } from 'drizzle-orm';
import { numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Bilingual text, `{ "en": ..., "ar": ... }`. At least one language is enforced by the Zod contract. */
export type LocalizedText = { en?: string; ar?: string } & Record<string, string | undefined>;

/** Time ordered uuid primary key (PostgreSQL 18 `uuidv7()`). */
export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

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
