import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins/admin';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ssdashboard/contracts';
import { schema, type Database } from '@ssdashboard/db';
import type { Env } from '../config/env.js';
import { createAuthHooks, type AuthHookDeps } from './auth-hooks.js';
import type { AuthMail } from './auth-mail.service.js';
import { SESSION_IDLE_SECONDS, SESSION_RENEW_SECONDS } from './session-policy.js';

/**
 * The one Better Auth instance (spec 0005). Sign up is closed, every staff account is made by
 * an admin or the `create-admin` command, and the session and user are read from the
 * database on every request (cookie caching stays off) so a disabled person fails at once.
 */
export function createAuth(
  env: Env,
  db: Database,
  parts: Pick<AuthHookDeps, 'lockout' | 'audit'> & {
    mail: Pick<AuthMail, 'queueReset' | 'completeReset'>;
  },
) {
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
        rateLimit: schema.rateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      // Our before hook gives the full rule (AC-8); these only keep Better Auth's own bounds equal.
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // Reset (spec 0005, AC-9). The email is queued, never sent here; with no mail on the
      // install, or for a disabled person, `queueReset` does nothing and the answer is the same.
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, token }) => parts.mail.queueReset(user, token),
      onPasswordReset: ({ user }, request) => parts.mail.completeReset(user, request),
    },
    // On in every environment (Better Auth turns it off outside production by default), with the
    // counters in PostgreSQL so a restart does not reset them (AC-4). Keys are per address and path.
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: {
        // A shared warehouse network must survive a shift change: 30 attempts a minute.
        '/sign-in/email': { window: 60, max: 30 },
        '/request-password-reset': { window: 15 * 60, max: 3 },
        '/reset-password': { window: 15 * 60, max: 5 },
        '/two-factor/verify-totp': { window: 10 * 60, max: 15 },
        '/two-factor/verify-backup-code': { window: 10 * 60, max: 15 },
      },
    },
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_RENEW_SECONDS,
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
    // The lock, the failure counters, and the last sign in time (AC-1, AC-2, AC-3, AC-23). The
    // after hook acts only when a full session was issued: the two factor slice keeps that rule.
    hooks: createAuthHooks({
      origin: new URL(env.PUBLIC_URL).origin,
      lockout: parts.lockout,
      audit: parts.audit,
    }),
    plugins: [admin({ defaultRole: 'staff', adminRoles: ['admin'] })],
  });
}
