import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { id, tenantId } from './columns.js';
import { parties } from './parties.js';

// The identity module's access tables (spec 0008, data model): which hats a person wears and
// which extra permissions they were granted. Both are current state, not history: a removed hat
// or grant is a deleted row, and the change itself is recorded by the audit trail (AC-13). The
// app role may insert, read and delete them, never update (`0002_baseline_rules.sql`). Only the
// identity module writes them.

/**
 * One hat a person wears (spec 0008, AC-1 to AC-3). The `partner` hat names exactly one partner
 * account and no other hat names one. Rules a check cannot hold (partner is the only hat, at
 * least one hat per person) are kept by identity under a lock on the person's `users` row.
 */
export const hatAssignments = pgTable(
  'hat_assignments',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    hat: text('hat').notNull(),
    partnerAccountId: uuid('partner_account_id').references(() => parties.id, {
      onDelete: 'restrict',
    }),
    /** Who gave the hat; null for `create-admin` and the migration's role mapping. */
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('hat_assignments_user_hat_unique').on(t.tenantId, t.userId, t.hat),
    check(
      'hat_assignments_hat_known',
      sql`${t.hat} IN ('support', 'operations', 'warehouse', 'manager', 'media_buyer', 'partner')`,
    ),
    check(
      'hat_assignments_partner_names_account',
      sql`(${t.hat} = 'partner') = (${t.partnerAccountId} IS NOT NULL)`,
    ),
    index('hat_assignments_hat_user_idx').on(t.hat, t.userId),
    index('hat_assignments_user_idx').on(t.userId),
    index('hat_assignments_partner_account_idx')
      .on(t.partnerAccountId)
      .where(sql`${t.partnerAccountId} IS NOT NULL`),
    index('hat_assignments_granted_by_idx')
      .on(t.grantedBy)
      .where(sql`${t.grantedBy} IS NOT NULL`),
  ],
);

/**
 * An extra permission given to one person on top of their hats (spec 0008, AC-6 and AC-7). Today
 * the only grantable permission is `cost.view`; a later grant widens the check.
 */
export const permissionGrants = pgTable(
  'permission_grants',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    permission: text('permission').notNull(),
    /** Who gave the grant; null for `create-admin` and the migration's role mapping. */
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('permission_grants_user_permission_unique').on(t.tenantId, t.userId, t.permission),
    check('permission_grants_permission_grantable', sql`${t.permission} IN ('cost.view')`),
    index('permission_grants_user_idx').on(t.userId),
    index('permission_grants_granted_by_idx')
      .on(t.grantedBy)
      .where(sql`${t.grantedBy} IS NOT NULL`),
  ],
);
