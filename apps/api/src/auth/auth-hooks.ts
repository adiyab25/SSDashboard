import { unmetPasswordRules } from '@ssdashboard/contracts';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import {
  AccountLocked,
  PasswordChanged,
  PasswordResetRequested,
  SignedIn,
  SignInFailed,
  TwoFactorDisabled,
  TwoFactorEnabled,
} from '../platform/events/auth-events.js';
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
  /** Reads a signed cookie; present on Better Auth's real request context. */
  getSignedCookie?: (name: string, secret: string) => Promise<string | null | undefined>;
  context: {
    returned?: unknown;
    newSession?: { user: { id: string; twoFactorEnabled?: boolean | null } } | null;
    secret?: string;
    createAuthCookie?: (name: string) => { name: string };
    internalAdapter: {
      updateUser: (id: string, data: Record<string, unknown>) => Promise<unknown>;
      findUserByEmail: (email: string) => Promise<{ user: { id: string } } | null>;
      deleteSession: (token: string) => Promise<unknown>;
      findUserById?: (id: string) => Promise<{ id: string; email: string } | null>;
      findVerificationValue?: (identifier: string) => Promise<{ value: string } | null>;
      consumeVerificationValue?: (identifier: string) => Promise<unknown>;
    };
  };
}

/**
 * What the sign in hooks need from outside: the trusted origin, the lockout and audit services,
 * and a clock and sleep that tests replace.
 */
export interface AuthHookDeps {
  origin: string;
  lockout: Pick<SignInLockout, 'isLocked' | 'recordFailure' | 'reset'>;
  audit: Pick<AuthAudit, 'record'>;
  now?: () => Date;
  /** Waits this many milliseconds; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const SIGN_IN = '/sign-in/email';
const REQUEST_RESET = '/request-password-reset';
const CHANGE_PASSWORD = '/change-password';
/** Routes that ask for the current password: a wrong one counts toward the lock (AC-3). */
const PASSWORD_ROUTES = new Set([
  CHANGE_PASSWORD,
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
]);
/** The two code routes, with the error each answers to a wrong code (spec 0005, AC-20). */
const CODE_ROUTES = new Map([
  ['/two-factor/verify-totp', { code: 'INVALID_CODE', message: 'Invalid code' }],
  [
    '/two-factor/verify-backup-code',
    { code: 'INVALID_BACKUP_CODE', message: 'Invalid backup code' },
  ],
]);
const TWO_FACTOR_COOKIE = 'two_factor';
interface Acting {
  id: string;
  email: string;
  /** The pending sign in's challenge, when the code answers a sign in rather than an enrollment. */
  challenge?: string;
  /** The person is confirming their first code, so two factor is being turned on. */
  enrolling?: boolean;
}
/** Who is acting on a password or code route, from the before hook to the after hook. */
const acting = new WeakMap<object, Acting>();
/** A reset request answers no faster than this, so the time cannot tell a real email from a fake one. */
export const RESET_RESPONSE_FLOOR_MS = 500;
/** When each reset request started, from the before hook to the after hook. */
const resetStartedAt = new WeakMap<object, number>();
/** Routes that start with no session, so there is nothing to cap or gate. */
const NO_SESSION_YET = new Set([SIGN_IN, '/request-password-reset', '/reset-password']);
/** Routes a session with the must change flag may still use (AC-14). */
const ALLOWED_WHILE_MUST_CHANGE = new Set(['/change-password', '/sign-out']);
const NEW_PASSWORD_PATHS = new Set(['/reset-password', '/change-password']);

// Spec 0005, AC-2: a locked account answers exactly like a wrong password. These are Better
// Auth's own code and message; the sign in e2e test compares both answers byte for byte.
const GENERIC_CODE = 'INVALID_EMAIL_OR_PASSWORD';
const GENERIC_MESSAGE = 'Invalid email or password';
/**
 * Builds the one error every failed sign in answers with, wrong password and locked account
 * alike, so the response never reveals which accounts exist or are locked.
 */
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

/** Ends a pending sign in, so no more codes can be tried against it. */
async function endChallenge(ctx: HookContext, challenge: string): Promise<void> {
  const { internalAdapter } = ctx.context;
  for (const identifier of [challenge, `2fa-attempts-${challenge}`]) {
    await internalAdapter.consumeVerificationValue?.(identifier).catch(() => undefined);
  }
}

/** What a before hook hands back to Better Auth to change the request it is about to run. */
export interface BeforeHookResult {
  context: { body: Record<string, unknown> };
}

/**
 * A password change always ends the person's other sessions (spec 0005, AC-14, AC-19), whatever
 * the client sent: a stolen session must not outlive the change. `undefined` leaves a body that is
 * not an object for Better Auth to refuse.
 */
export function forceRevokeOtherSessions(body: unknown): BeforeHookResult | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  return { context: { body: { ...(body as Record<string, unknown>), revokeOtherSessions: true } } };
}

/**
 * Runs before every Better Auth route that the allowlist lets through (spec 0005, AC-2, AC-3,
 * AC-7, AC-8): the Origin check, the weak password answer, the 7 day cap, the must change rule,
 * and the sign in lock. Routes our own guard protects never come here.
 */
export function createBeforeHook(deps: AuthHookDeps) {
  const now = deps.now ?? (() => new Date());
  return beforeAuth;

  async function beforeAuth(ctx: HookContext): Promise<BeforeHookResult | undefined> {
    await checkBefore(ctx);
    return ctx.request !== undefined && ctx.path === CHANGE_PASSWORD
      ? forceRevokeOtherSessions(ctx.body)
      : undefined;
  }

  async function checkBefore(ctx: HookContext): Promise<void> {
    // Our own guard calls `getSession` through the same pipeline with no HTTP request. That call
    // is the guard's to judge, so only a request that came in over HTTP is checked here.
    if (ctx.request === undefined) return;
    const path = ctx.path ?? '';

    // Beyond Better Auth's own check: a write from another site never carries our authority.
    if (ctx.request.method !== 'GET' && requestHeaders(ctx)?.get('origin') !== deps.origin) {
      throw APIError.from('FORBIDDEN', { code: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' });
    }

    if (path === REQUEST_RESET) resetStartedAt.set(ctx.request, now().getTime());

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

    const codeRoute = CODE_ROUTES.get(path);
    if (codeRoute) return beforeCode(ctx, codeRoute);

    // The token check (`GET /reset-password/:token`) runs before anyone has a session.
    if (NO_SESSION_YET.has(path) || path.startsWith('/reset-password/') || path === '/sign-out') {
      return;
    }

    // Routes that need a session: the 7 day cap and the must change rule.
    const session = await getSessionFromCtx(ctx as never);
    if (!session) return; // The route itself answers 401.
    await assertLiveSession(ctx, session, path);

    if (PASSWORD_ROUTES.has(path)) {
      const who: Acting = { id: session.user.id, email: session.user.email };
      acting.set(ctx.request, who);
      // A wrong current password counts toward the same lock as sign in (AC-3), so a stolen
      // session cannot be used to guess the password. During a lock the answer is the same
      // as for a wrong one.
      if (await deps.lockout.isLocked(emailKey(who.email), clientIp(requestHeaders(ctx)))) {
        throw APIError.from('BAD_REQUEST', {
          code: 'INVALID_PASSWORD',
          message: 'Invalid password',
        });
      }
    }
  }

  /** The 7 day cap and the must change rule, for a route that needs a signed in person. */
  async function assertLiveSession(
    ctx: HookContext,
    session: { session: { createdAt: Date | string; token: string }; user: object },
    path: string,
  ): Promise<void> {
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
  }

  /**
   * A second factor code, for a sign in that is waiting on one or for a person confirming their
   * first code (AC-20). Trusted devices are never honored, so asking for one is refused. The lock
   * key comes from the person behind the pending sign in; while locked the answer is the same as
   * for a wrong code, and the pending sign in ends.
   */
  async function beforeCode(
    ctx: HookContext,
    route: { code: string; message: string },
  ): Promise<void> {
    if (typeof ctx.body === 'object' && ctx.body !== null && 'trustDevice' in ctx.body) {
      if ((ctx.body as { trustDevice?: unknown }).trustDevice) {
        throw APIError.from('BAD_REQUEST', {
          code: 'TRUST_DEVICE_NOT_SUPPORTED',
          message: 'Remembering this device is not available',
        });
      }
    }
    let who: Acting | undefined;
    const session = await getSessionFromCtx(ctx as never);
    if (session) {
      await assertLiveSession(ctx, session, ctx.path ?? '');
      const enabled = (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled;
      who = { id: session.user.id, email: session.user.email, enrolling: !enabled };
    } else {
      who = await pendingPerson(ctx);
    }
    if (!who || !ctx.request) return; // The route itself answers a missing challenge.
    acting.set(ctx.request, who);
    if (await deps.lockout.isLocked(emailKey(who.email), clientIp(requestHeaders(ctx)))) {
      if (who.challenge) await endChallenge(ctx, who.challenge);
      throw APIError.from('UNAUTHORIZED', route);
    }
  }

  /** The person behind a sign in that is waiting on a second factor, from the signed cookie. */
  async function pendingPerson(ctx: HookContext): Promise<Acting | undefined> {
    const { getSignedCookie } = ctx;
    const { createAuthCookie, secret, internalAdapter } = ctx.context;
    if (!getSignedCookie || !createAuthCookie || !secret) return undefined;
    const challenge = await getSignedCookie(createAuthCookie(TWO_FACTOR_COOKIE).name, secret);
    if (!challenge || !internalAdapter.findVerificationValue || !internalAdapter.findUserById) {
      return undefined;
    }
    const pending = await internalAdapter.findVerificationValue(challenge);
    const user = pending ? await internalAdapter.findUserById(pending.value) : null;
    return user ? { id: user.id, email: user.email, challenge } : undefined;
  }
}

/**
 * Runs after every Better Auth route. For sign in it keeps the failure counters, the last
 * sign in time and the events. A lock, a bad password and a disabled account are told apart
 * here; a disabled account with the right password counts as neither a failure nor a reset.
 */
export function createAfterHook(deps: AuthHookDeps) {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  /** Pads the answer to the floor, and records the request (with no target for an unknown email). */
  async function afterResetRequest(ctx: HookContext): Promise<void> {
    const email = bodyField(ctx.body, 'email');
    if (email !== undefined && !(ctx.context.returned instanceof APIError)) {
      const found = await ctx.context.internalAdapter.findUserByEmail(emailKey(email));
      deps.audit.record(
        new PasswordResetRequested(eventContext(ctx, null, found?.user.id ?? null, now())),
      );
    }
    const started = ctx.request ? resetStartedAt.get(ctx.request) : undefined;
    if (started === undefined) return;
    const wait = RESET_RESPONSE_FLOOR_MS - (now().getTime() - started);
    if (wait > 0) await sleep(wait);
  }

  function lockEvents(
    ctx: HookContext,
    who: { id: string | null },
    outcome: { pairLocked: boolean; emailLocked: boolean },
  ): void {
    if (outcome.pairLocked) {
      deps.audit.record(new AccountLocked(eventContext(ctx, who.id, who.id, now()), 'pair'));
    }
    if (outcome.emailLocked) {
      deps.audit.record(new AccountLocked(eventContext(ctx, who.id, who.id, now()), 'email'));
    }
  }

  /** A full session was issued: stamp the sign in, clear the counters, and record it. */
  async function fullSignIn(ctx: HookContext, userId: string, key: string): Promise<void> {
    const at = now();
    await ctx.context.internalAdapter.updateUser(userId, { lastSignInAt: at });
    await deps.lockout.reset(key);
    deps.audit.record(new SignedIn(eventContext(ctx, userId, userId, at)));
  }

  /**
   * A route that asks for the current password. A wrong one counts toward the lock. A good change
   * clears the forced change; a good two factor disable is recorded.
   */
  async function afterPasswordRoute(ctx: HookContext): Promise<void> {
    const who = ctx.request ? acting.get(ctx.request) : undefined;
    if (!who) return;
    const { returned } = ctx.context;
    if (returned instanceof APIError) {
      if (errorCode(returned) !== 'INVALID_PASSWORD') return;
      lockEvents(
        ctx,
        who,
        await deps.lockout.recordFailure(emailKey(who.email), clientIp(requestHeaders(ctx))),
      );
      return;
    }
    if (ctx.path === CHANGE_PASSWORD) {
      await ctx.context.internalAdapter.updateUser(who.id, { mustChangePassword: false });
      deps.audit.record(new PasswordChanged(eventContext(ctx, who.id, who.id, now())));
    } else if (ctx.path === '/two-factor/disable') {
      deps.audit.record(new TwoFactorDisabled(eventContext(ctx, who.id, who.id, now())));
    }
  }

  /**
   * A second factor code. A wrong one counts toward the same lock as a wrong password, and a
   * lock ends the pending sign in (AC-3). A right one finishes the sign in, or turns two factor on.
   */
  async function afterCode(ctx: HookContext): Promise<void> {
    const route = ctx.path ? CODE_ROUTES.get(ctx.path) : undefined;
    const who = ctx.request ? acting.get(ctx.request) : undefined;
    if (!route || !who) return;
    const { returned } = ctx.context;
    if (returned instanceof APIError) {
      if (errorCode(returned) !== route.code) return;
      const outcome = await deps.lockout.recordFailure(
        emailKey(who.email),
        clientIp(requestHeaders(ctx)),
      );
      if (!who.enrolling) {
        deps.audit.record(
          new SignInFailed(eventContext(ctx, null, who.id, now()), 'bad_credentials'),
        );
      }
      lockEvents(ctx, { id: who.id }, outcome);
      if ((outcome.pairLocked || outcome.emailLocked) && who.challenge) {
        await endChallenge(ctx, who.challenge);
      }
      return;
    }
    if (who.enrolling) {
      deps.audit.record(new TwoFactorEnabled(eventContext(ctx, who.id, who.id, now())));
      return;
    }
    const issued = ctx.context.newSession;
    if (issued) await fullSignIn(ctx, issued.user.id, emailKey(who.email));
  }

  return async function afterAuth(ctx: HookContext): Promise<void> {
    if (ctx.request === undefined) return;
    if (ctx.path === REQUEST_RESET) return afterResetRequest(ctx);
    if (ctx.path && PASSWORD_ROUTES.has(ctx.path)) return afterPasswordRoute(ctx);
    if (ctx.path && CODE_ROUTES.has(ctx.path)) return afterCode(ctx);
    if (ctx.path !== SIGN_IN) return;
    const email = bodyField(ctx.body, 'email');
    if (email === undefined) return;
    const key = emailKey(email);
    const { returned } = ctx.context;

    const issued = ctx.context.newSession;
    if (issued && !(returned instanceof APIError)) {
      // With two factor on, the password step is not a sign in: Better Auth takes this session
      // back and asks for a code. The counters, the last sign in time and `SignedIn` wait for the
      // code (AC-3, AC-23).
      if (issued.user.twoFactorEnabled) return;
      await fullSignIn(ctx, issued.user.id, key);
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
    lockEvents(ctx, { id: null }, outcome);
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
