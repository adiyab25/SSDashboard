import { unmetPasswordRules } from '@ssdashboard/contracts';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import { AccountLocked, SignedIn, SignInFailed } from '../platform/events/auth-events.js';
import type { AuthAudit } from './auth-audit.service.js';
import { clientIp, emailKey, userAgent } from './client-info.js';
import { pastAbsoluteCap } from './session-policy.js';
import type { SignInLockout } from './sign-in-lockout.js';

/** What a hook reads of Better Auth's request context; kept narrow so tests can fake it. */
export interface HookContext {
  path?: string | undefined;
  headers?: Headers | undefined;
  request?: Request | undefined;
  body?: unknown;
  context: {
    returned?: unknown;
    newSession?: { user: { id: string } } | null;
    internalAdapter: {
      updateUser: (id: string, data: Record<string, unknown>) => Promise<unknown>;
      findUserByEmail: (email: string) => Promise<{ user: { id: string } } | null>;
      deleteSession: (token: string) => Promise<unknown>;
    };
  };
}

export interface AuthHookDeps {
  origin: string;
  lockout: Pick<SignInLockout, 'isLocked' | 'recordFailure' | 'reset'>;
  audit: Pick<AuthAudit, 'record'>;
  now?: () => Date;
}

const SIGN_IN = '/sign-in/email';
/** Routes that start with no session, so there is nothing to cap or gate. */
const NO_SESSION_YET = new Set([
  SIGN_IN,
  '/request-password-reset',
  '/reset-password',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]);
/** Routes a session with the must change flag may still use (AC-14). */
const ALLOWED_WHILE_MUST_CHANGE = new Set(['/change-password', '/sign-out']);
const NEW_PASSWORD_PATHS = new Set(['/reset-password', '/change-password']);

// Spec 0005, AC-2: a locked account answers exactly like a wrong password. These are Better
// Auth's own code and message; the sign in e2e test compares both answers byte for byte.
const GENERIC_CODE = 'INVALID_EMAIL_OR_PASSWORD';
const GENERIC_MESSAGE = 'Invalid email or password';
export const genericSignInError = () =>
  APIError.from('UNAUTHORIZED', { code: GENERIC_CODE, message: GENERIC_MESSAGE });

const bodyField = (body: unknown, name: string): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
};

const errorCode = (value: unknown): string | undefined =>
  value instanceof APIError ? (value.body as { code?: string } | undefined)?.code : undefined;

const requestHeaders = (ctx: HookContext): Headers | undefined =>
  ctx.headers ?? ctx.request?.headers;

function eventContext(ctx: HookContext, actorId: string | null, targetId: string | null, at: Date) {
  const headers = requestHeaders(ctx);
  return { actorId, targetId, ip: clientIp(headers), userAgent: userAgent(headers), at };
}

/**
 * Runs before every Better Auth route that the allowlist lets through (spec 0005, AC-2, AC-3,
 * AC-7, AC-8): the Origin check, the weak password answer, the 7 day cap, the must change rule,
 * and the sign in lock. Routes our own guard protects never come here.
 */
export function createBeforeHook(deps: AuthHookDeps) {
  const now = deps.now ?? (() => new Date());
  return async function beforeAuth(ctx: HookContext): Promise<void> {
    // Our own guard calls `getSession` through the same pipeline with no HTTP request. That call
    // is the guard's to judge, so only a request that came in over HTTP is checked here.
    if (ctx.request === undefined) return;
    const path = ctx.path ?? '';

    // Beyond Better Auth's own check: a write from another site never carries our authority.
    if (ctx.request.method !== 'GET' && requestHeaders(ctx)?.get('origin') !== deps.origin) {
      throw APIError.from('FORBIDDEN', { code: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' });
    }

    if (NEW_PASSWORD_PATHS.has(path)) {
      const unmet = unmetPasswordRules(bodyField(ctx.body, 'newPassword') ?? '');
      if (unmet.length > 0) {
        throw new APIError('UNPROCESSABLE_ENTITY', {
          code: 'WEAK_PASSWORD',
          message: 'The password does not meet the rules',
          unmet,
        });
      }
    }

    if (path === SIGN_IN) {
      const email = bodyField(ctx.body, 'email');
      if (email === undefined) return; // Better Auth answers a malformed body itself.
      const key = emailKey(email);
      if (await deps.lockout.isLocked(key, clientIp(requestHeaders(ctx)))) {
        // Hash a password the way a real attempt would, so a lock cannot be told by timing.
        await hashPassword(bodyField(ctx.body, 'password') ?? '');
        const found = await ctx.context.internalAdapter.findUserByEmail(key);
        deps.audit.record(
          new SignInFailed(eventContext(ctx, null, found?.user.id ?? null, now()), 'locked'),
        );
        throw genericSignInError();
      }
      return;
    }

    if (NO_SESSION_YET.has(path) || path === '/sign-out') return;

    // Routes that need a session: the 7 day cap and the must change rule.
    const session = await getSessionFromCtx(ctx as never);
    if (!session) return; // The route itself answers 401.
    if (pastAbsoluteCap(session.session.createdAt, now())) {
      await ctx.context.internalAdapter.deleteSession(session.session.token);
      throw APIError.from('UNAUTHORIZED', {
        code: 'SESSION_EXPIRED',
        message: 'Your session has ended. Sign in again.',
      });
    }
    const mustChange = (session.user as { mustChangePassword?: boolean }).mustChangePassword;
    if (mustChange && !ALLOWED_WHILE_MUST_CHANGE.has(path)) {
      throw APIError.from('FORBIDDEN', {
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Change your password to continue.',
      });
    }
  };
}

/**
 * Runs after every Better Auth route. For sign in it keeps the failure counters, the last
 * sign in time and the events. A lock, a bad password and a disabled account are told apart
 * here; a disabled account with the right password counts as neither a failure nor a reset.
 */
export function createAfterHook(deps: AuthHookDeps) {
  const now = deps.now ?? (() => new Date());
  return async function afterAuth(ctx: HookContext): Promise<void> {
    if (ctx.request === undefined || ctx.path !== SIGN_IN) return;
    const email = bodyField(ctx.body, 'email');
    if (email === undefined) return;
    const key = emailKey(email);
    const { returned } = ctx.context;

    const issued = ctx.context.newSession;
    if (issued && !(returned instanceof APIError)) {
      // A full session was issued; the two factor slice keeps this rule for its own step.
      const at = now();
      await ctx.context.internalAdapter.updateUser(issued.user.id, { lastSignInAt: at });
      await deps.lockout.reset(key);
      deps.audit.record(new SignedIn(eventContext(ctx, issued.user.id, issued.user.id, at)));
      return;
    }

    const code = errorCode(returned);
    if (code !== GENERIC_CODE && code !== 'BANNED_USER') return;
    const found = await ctx.context.internalAdapter.findUserByEmail(key);
    const targetId = found?.user.id ?? null;

    if (code === 'BANNED_USER') {
      deps.audit.record(new SignInFailed(eventContext(ctx, null, targetId, now()), 'disabled'));
      return;
    }
    const outcome = await deps.lockout.recordFailure(key, clientIp(requestHeaders(ctx)));
    deps.audit.record(
      new SignInFailed(eventContext(ctx, null, targetId, now()), 'bad_credentials'),
    );
    if (outcome.pairLocked) {
      deps.audit.record(new AccountLocked(eventContext(ctx, null, targetId, now()), 'pair'));
    }
    if (outcome.emailLocked) {
      deps.audit.record(new AccountLocked(eventContext(ctx, null, targetId, now()), 'email'));
    }
  };
}

/** Wraps both hooks for Better Auth's `hooks` option. */
export function createAuthHooks(deps: AuthHookDeps) {
  const before = createBeforeHook(deps);
  const after = createAfterHook(deps);
  return {
    before: createAuthMiddleware(async (ctx) => before(ctx as unknown as HookContext)),
    after: createAuthMiddleware(async (ctx) => after(ctx as unknown as HookContext)),
  };
}
