import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';
import { AccountLocked, SignedIn, SignInFailed } from '../platform/events/auth-events.js';
import { createAfterHook, createBeforeHook, type HookContext } from './auth-hooks.js';

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
      newSession?: { user: { id: string } } | null;
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
