import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountLocked,
  PasswordResetRequested,
  SignedIn,
  SignInFailed,
} from '../platform/events/auth-events.js';
import {
  createAfterHook,
  createBeforeHook,
  forceRevokeOtherSessions,
  RESET_RESPONSE_FLOOR_MS,
  type HookContext,
} from './auth-hooks.js';

const ORIGIN = 'https://erp.example.com';
const NOW = new Date('2026-11-03T10:00:00Z');
const USER_ID = '0190c0de-0000-7000-8000-000000000001';

function setup(lock = { locked: false }) {
  const lockout = {
    isLocked: vi.fn(() => Promise.resolve(lock.locked)),
    recordFailure: vi.fn(() => Promise.resolve({ pairLocked: false, emailLocked: false })),
    reset: vi.fn(() => Promise.resolve()),
  };
  const audit = { record: vi.fn<(event: unknown) => void>() };
  const deps = { origin: ORIGIN, lockout, audit, now: () => NOW };
  const internalAdapter = {
    updateUser: vi.fn(() => Promise.resolve()),
    findUserByEmail: vi.fn(() => Promise.resolve({ user: { id: USER_ID } })),
    deleteSession: vi.fn(() => Promise.resolve()),
  };
  const context = (
    path: string,
    options: {
      method?: string;
      origin?: string;
      body?: unknown;
      returned?: unknown;
      newSession?: { user: { id: string; twoFactorEnabled?: boolean } } | null;
      ip?: string;
    } = {},
  ): HookContext => {
    const headers = new Headers({ 'x-forwarded-for': options.ip ?? '203.0.113.7' });
    if (options.origin) headers.set('origin', options.origin);
    return {
      path,
      headers,
      request: new Request(`${ORIGIN}/api/auth${path}`, { method: options.method ?? 'POST' }),
      body: options.body,
      context: { returned: options.returned, newSession: options.newSession, internalAdapter },
    };
  };
  return {
    lockout,
    audit,
    internalAdapter,
    context,
    before: createBeforeHook(deps),
    after: createAfterHook(deps),
  };
}

const wrongPassword = () =>
  APIError.from('UNAUTHORIZED', {
    code: 'INVALID_EMAIL_OR_PASSWORD',
    message: 'Invalid email or password',
  });

describe('before hook', () => {
  it('ignores a call that came in with no HTTP request (the guard reading the session)', async () => {
    const { before, context, lockout } = setup({ locked: true });
    const ctx = { ...context('/sign-in/email'), request: undefined };

    await expect(before(ctx)).resolves.toBeUndefined();
    expect(lockout.isLocked).not.toHaveBeenCalled();
  });

  it('rejects a write from another origin and one with no origin', async () => {
    const { before, context } = setup();

    for (const origin of ['https://evil.example', undefined]) {
      await expect(before(context('/sign-out', origin ? { origin } : {}))).rejects.toMatchObject({
        body: { code: 'FORBIDDEN_ORIGIN' },
      });
    }
    await expect(before(context('/sign-out', { origin: ORIGIN }))).resolves.toBeUndefined();
  });

  describe('sign in lock (AC-2, AC-3)', () => {
    it('answers a locked pair with the same error as a wrong password', async () => {
      const { before, context, audit } = setup({ locked: true });
      const body = { email: 'Sam@Example.com', password: 'Correct-Horse-1' };

      const error = await before(context('/sign-in/email', { origin: ORIGIN, body })).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).statusCode).toBe(401);
      expect((error as APIError).body).toEqual(wrongPassword().body);
      expect(audit.record).toHaveBeenCalledWith(expect.any(SignInFailed));
      expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
        reason: 'locked',
        context: { targetId: USER_ID, actorId: null, ip: '203.0.113.7' },
      });
    });

    it('keys the lock on the trimmed lowercase email and the client address', async () => {
      const { before, context, lockout } = setup();

      await before(
        context('/sign-in/email', {
          origin: ORIGIN,
          body: { email: '  Sam@Example.com ', password: 'x' },
        }),
      );

      expect(lockout.isLocked).toHaveBeenCalledWith('sam@example.com', '203.0.113.7');
    });

    it('leaves a body with no email to Better Auth', async () => {
      const { before, context, lockout } = setup();

      await before(context('/sign-in/email', { origin: ORIGIN, body: { password: 'x' } }));

      expect(lockout.isLocked).not.toHaveBeenCalled();
    });
  });

  describe('weak passwords (AC-8)', () => {
    it.each(['/reset-password', '/change-password'])(
      'answers 422 WEAK_PASSWORD with the unmet rules on %s',
      async (path) => {
        const { before, context } = setup();

        const error = await before(
          context(path, { origin: ORIGIN, body: { newPassword: 'abc' } }),
        ).catch((e: unknown) => e);

        expect((error as APIError).statusCode).toBe(422);
        expect((error as APIError).body).toMatchObject({
          code: 'WEAK_PASSWORD',
          unmet: ['min_length', 'uppercase', 'digit'],
        });
      },
    );

    it('treats a missing new password as weak, never as fine', async () => {
      const { before, context } = setup();

      await expect(
        before(context('/reset-password', { origin: ORIGIN, body: {} })),
      ).rejects.toMatchObject({ body: { code: 'WEAK_PASSWORD' } });
    });
  });
});

describe('password change ends the other sessions (AC-14, AC-19)', () => {
  it('sets revokeOtherSessions to true whatever the client sent, keeping the rest of the body', () => {
    for (const sent of [{}, { revokeOtherSessions: false }, { revokeOtherSessions: 'no' }]) {
      const body = { currentPassword: 'Old-Pass-1', newPassword: 'New-Pass-1', ...sent };
      expect(forceRevokeOtherSessions(body)).toEqual({
        context: {
          body: {
            currentPassword: 'Old-Pass-1',
            newPassword: 'New-Pass-1',
            revokeOtherSessions: true,
          },
        },
      });
    }
  });

  it('leaves a body that is not an object for Better Auth to refuse', () => {
    for (const body of [undefined, null, 'text', ['a']]) {
      expect(forceRevokeOtherSessions(body)).toBeUndefined();
    }
  });
});

describe('after hook', () => {
  it('on a full session: stamps the last sign in, clears the counters, emits SignedIn', async () => {
    const { after, context, internalAdapter, lockout, audit } = setup();

    await after(
      context('/sign-in/email', {
        body: { email: 'Sam@Example.com' },
        newSession: { user: { id: USER_ID } },
        returned: { token: 't' },
      }),
    );

    expect(internalAdapter.updateUser).toHaveBeenCalledWith(USER_ID, { lastSignInAt: NOW });
    expect(lockout.reset).toHaveBeenCalledWith('sam@example.com');
    expect(audit.record).toHaveBeenCalledWith(expect.any(SignedIn));
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('with two factor on, the password step is not a sign in: nothing is stamped, cleared or recorded (AC-3, AC-23)', async () => {
    const { after, context, internalAdapter, lockout, audit } = setup();

    await after(
      context('/sign-in/email', {
        body: { email: 'Sam@Example.com' },
        newSession: { user: { id: USER_ID, twoFactorEnabled: true } },
        returned: { twoFactorRedirect: true },
      }),
    );

    expect(internalAdapter.updateUser).not.toHaveBeenCalled();
    expect(lockout.reset).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('on a wrong password: counts the failure and emits SignInFailed', async () => {
    const { after, context, lockout, audit, internalAdapter } = setup();

    await after(
      context('/sign-in/email', { body: { email: 'sam@example.com' }, returned: wrongPassword() }),
    );

    expect(lockout.recordFailure).toHaveBeenCalledWith('sam@example.com', '203.0.113.7');
    expect(lockout.reset).not.toHaveBeenCalled();
    expect(internalAdapter.updateUser).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({ reason: 'bad_credentials' });
  });

  it('emits AccountLocked once for the lock a failure started', async () => {
    const { after, context, lockout, audit } = setup();
    lockout.recordFailure.mockResolvedValueOnce({ pairLocked: true, emailLocked: false });

    await after(
      context('/sign-in/email', { body: { email: 'sam@example.com' }, returned: wrongPassword() }),
    );

    const events = audit.record.mock.calls.map((call) => call[0]);
    expect(events.filter((event) => event instanceof AccountLocked)).toHaveLength(1);
    expect(events[1]).toMatchObject({ scope: 'pair' });
  });

  it('a disabled account with the right password is neither a failure nor a reset', async () => {
    const { after, context, lockout, audit } = setup();
    const banned = APIError.from('FORBIDDEN', { code: 'BANNED_USER', message: 'disabled' });

    await after(
      context('/sign-in/email', { body: { email: 'sam@example.com' }, returned: banned }),
    );

    expect(lockout.recordFailure).not.toHaveBeenCalled();
    expect(lockout.reset).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({ reason: 'disabled' });
  });

  it('does not count an error that is not a credential failure', async () => {
    const { after, context, lockout, audit } = setup();
    const invalid = APIError.from('BAD_REQUEST', { code: 'VALIDATION_ERROR', message: 'bad body' });

    await after(
      context('/sign-in/email', { body: { email: 'sam@example.com' }, returned: invalid }),
    );

    expect(lockout.recordFailure).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records an unknown email with no target, so it looks like a real one in the counters', async () => {
    const { after, context, lockout, audit, internalAdapter } = setup();
    internalAdapter.findUserByEmail.mockResolvedValueOnce(null as never);

    await after(
      context('/sign-in/email', {
        body: { email: 'nobody@example.com' },
        returned: wrongPassword(),
      }),
    );

    expect(lockout.recordFailure).toHaveBeenCalledWith('nobody@example.com', '203.0.113.7');
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({ context: { targetId: null } });
  });
});

describe('password reset request (AC-9)', () => {
  function resetSetup(found: { user: { id: string } } | null) {
    let clock = NOW.getTime();
    const sleep = vi.fn((ms: number) => {
      clock += ms;
      return Promise.resolve();
    });
    const audit = { record: vi.fn<(event: unknown) => void>() };
    const deps = {
      origin: ORIGIN,
      lockout: { isLocked: vi.fn(), recordFailure: vi.fn(), reset: vi.fn() },
      audit,
      now: () => new Date(clock),
      sleep,
    } as unknown as Parameters<typeof createBeforeHook>[0];
    const request = new Request(`${ORIGIN}/api/auth/request-password-reset`, { method: 'POST' });
    const ctx = (returned?: unknown): HookContext => ({
      path: '/request-password-reset',
      headers: new Headers({ origin: ORIGIN, 'x-forwarded-for': '203.0.113.7' }),
      request,
      body: { email: 'Sam@Example.com' },
      context: {
        returned,
        internalAdapter: {
          updateUser: vi.fn(),
          findUserByEmail: vi.fn(() => Promise.resolve(found)),
          deleteSession: vi.fn(),
        },
      },
    });
    return {
      before: createBeforeHook(deps),
      after: createAfterHook(deps),
      sleep,
      audit,
      ctx,
      advance: (ms: number) => (clock += ms),
    };
  }

  it('pads a quick answer up to 500 ms, whether or not the account exists', async () => {
    for (const found of [{ user: { id: USER_ID } }, null]) {
      const { before, after, sleep, ctx } = resetSetup(found);

      await before(ctx());
      await after(ctx({ status: true }));

      expect(sleep).toHaveBeenCalledWith(RESET_RESPONSE_FLOOR_MS);
    }
  });

  it('waits only for what is left when the answer was already slow', async () => {
    const { before, after, sleep, ctx, advance } = resetSetup({ user: { id: USER_ID } });

    await before(ctx());
    advance(420);
    await after(ctx({ status: true }));

    expect(sleep).toHaveBeenCalledWith(80);
  });

  it('does not wait when the answer already took longer than 500 ms', async () => {
    const { before, after, sleep, ctx, advance } = resetSetup(null);

    await before(ctx());
    advance(900);
    await after(ctx({ status: true }));

    expect(sleep).not.toHaveBeenCalled();
  });

  it('records the request with the target for a real email and none for an unknown one', async () => {
    const real = resetSetup({ user: { id: USER_ID } });
    await real.before(real.ctx());
    await real.after(real.ctx({ status: true }));
    expect(real.audit.record.mock.calls[0]?.[0]).toBeInstanceOf(PasswordResetRequested);
    expect(real.audit.record.mock.calls[0]?.[0]).toMatchObject({
      context: { actorId: null, targetId: USER_ID, ip: '203.0.113.7' },
    });

    const unknown = resetSetup(null);
    await unknown.before(unknown.ctx());
    await unknown.after(unknown.ctx({ status: true }));
    expect(unknown.audit.record.mock.calls[0]?.[0]).toMatchObject({ context: { targetId: null } });
  });

  it('lets the token check through with no session', async () => {
    const { before } = resetSetup(null);
    const check: HookContext = {
      ...resetSetup(null).ctx(),
      path: '/reset-password/:token',
      request: new Request(`${ORIGIN}/api/auth/reset-password/abc?callbackURL=x`),
    };

    await expect(before(check)).resolves.toBeUndefined();
  });
});
