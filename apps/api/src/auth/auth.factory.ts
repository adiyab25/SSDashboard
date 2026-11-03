import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins/admin';
import { schema, type Database } from '@ssdashboard/db';
import type { Env } from '../config/env.js';

const HOUR_SECONDS = 60 * 60;

/**
 * The one Better Auth instance (spec 0005). Sign up is closed, every staff account is made by
 * an admin or the `create-admin` command, and the session and user are read from the
 * database on every request (cookie caching stays off) so a disabled person fails at once.
 */
export function createAuth(env: Env, db: Database) {
  return betterAuth({
    appName: env.CLIENT_DISPLAY_NAME,
    baseURL: env.PUBLIC_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(env.PUBLIC_URL).origin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    // On in every environment (Better Auth turns it off outside production by default). The
    // counters are in memory for now; the hardening slice moves them to PostgreSQL (AC-4).
    rateLimit: {
      enabled: true,
      // A shared warehouse network must survive a shift change: 30 attempts a minute per address.
      customRules: { '/sign-in/email': { window: 60, max: 30 } },
    },
    session: {
      expiresIn: 12 * HOUR_SECONDS,
      updateAge: HOUR_SECONDS,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        phone: { type: 'string', required: false, input: false },
        staffCode: { type: 'string', required: false, input: false },
        language: { type: 'string', required: false, input: false },
        mustChangePassword: { type: 'boolean', required: true, defaultValue: false, input: false },
        lastSignInAt: { type: 'date', required: false, input: false },
      },
    },
    advanced: {
      useSecureCookies: env.PUBLIC_URL.startsWith('https:'),
      // The database makes the uuid (`uuidv7()`), like every other table.
      database: { generateId: false },
      // Caddy sets this header and overwrites any value the client sends.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    hooks: {
      // Runs only when a full session was issued (spec 0005, AC-1). The two factor slice
      // keeps this rule: a session made after just the password step never counts.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const issued = ctx.context.newSession;
        if (!issued) return;
        await ctx.context.internalAdapter.updateUser(issued.user.id, {
          lastSignInAt: new Date(),
        });
      }),
    },
    plugins: [admin({ defaultRole: 'staff', adminRoles: ['admin'] })],
  });
}
