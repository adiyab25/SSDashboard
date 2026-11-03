import {
  bigint,
  boolean,
  check,
  integer,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, id, updatedAt } from './columns.js';

/**
 * Staff accounts (spec 0005). Better Auth reads and writes this table through its `modelName`
 * and `fields` options, so the column names here are ours and the field names are its.
 * Accounts are disabled (`banned`), never deleted: ledger rows reference them for good.
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    /** Unused. Better Auth models an avatar and checks that the column exists. */
    image: text('image'),
    /** `admin` or `staff`. Feature 13 replaces this check with real roles. */
    role: text('role').notNull().default('staff'),
    banned: boolean('banned').notNull().default(false),
    banReason: text('ban_reason'),
    /** Unused: bans are permanent. */
    banExpires: timestamp('ban_expires', { withTimezone: true }),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    phone: text('phone'),
    staffCode: text('staff_code'),
    language: text('language'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    uniqueIndex('users_staff_code_unique')
      .on(t.staffCode)
      .where(sql`${t.staffCode} is not null`),
    check('users_role_check', sql`${t.role} in ('admin', 'staff')`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** Unused: impersonation is closed. Better Auth's admin plugin checks that the column exists. */
    impersonatedBy: text('impersonated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/** The password lives here as a hash, one `credential` row per user. */
export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    password: text('password'),
    // Better Auth adds the OAuth columns to its model; they stay unused here.
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('accounts_provider_account_unique').on(t.providerId, t.accountId),
    index('accounts_user_idx').on(t.userId),
  ],
);

/** Reset and invite tokens. Single use and short lived. */
export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier, t.expiresAt)],
);

/** Better Auth's per address and path counters, kept here so a restart does not reset them. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    id: id(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    /** Milliseconds since the epoch, as Better Auth writes it. */
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('rate_limits_key_unique').on(t.key)],
);

/**
 * Failed sign in counters (spec 0005, AC-3). One row per lowercase trimmed email text (real or
 * not, so an unknown email behaves like a real one) and scope: the client IP, or `*` for the
 * row that counts every address. Both rows are written by one atomic upsert.
 */
export const signInAttempts = pgTable(
  'sign_in_attempts',
  {
    emailKey: text('email_key').notNull(),
    scope: text('scope').notNull(),
    failures: integer('failures').notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.emailKey, t.scope] })],
);
