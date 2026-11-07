import { Logger } from '@nestjs/common';
import { PASSWORD_MAX_LENGTH } from '@ssdashboard/contracts';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountLocked,
  PasswordResetRequested,
  SignedIn,
  SignInFailed,
} from '../../platform/events/auth-events.js';
import {
  createAfterHook,
  createBeforeHook,
  forceRevokeOtherSessions,
  RESET_RESPONSE_FLOOR_MS,
  type HookContext,
} from './auth-hooks.js';
import type { FailureOutcome, TakenSlot } from './sign-in-lockout.js';

// The full window answer hashes a password as a timing pad; the code and password routes read
// the session. Both are Better Auth's own, replaced here so the hooks can be run alone.
vi.mock('better-auth/crypto', () => ({ hashPassword: vi.fn(() => Promise.resolve('hash')) }));
vi.mock('better-auth/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionFromCtx: vi.fn(() => Promise.resolve(null)),
}));

beforeEach(() => {
  vi.mocked(hashPassword).mockClear();
  vi.mocked(getSessionFromCtx).mockReset().mockResolvedValue(null);
});

const ORIGIN = 'https://erp.example.com';
const NOW = new Date('2026-11-03T10:00:00Z');
const USER_ID = '0190c0de-0000-7000-8000-000000000001';
const SLOT = '0190c0de-0000-7000-8000-0000000000aa';
const NO_LOCK = { pairLocked: false, emailLocked: false };

function setup(lock = { locked: false }) {
  const lockout = {
    takeSlot: vi.fn((): Promise<TakenSlot> =>
      Promise.resolve(lock.locked ? { slot: null, locked: true } : { slot: SLOT }),
    ),
    giveBack: vi.fn((): Promise<FailureOutcome> => Promise.resolve(NO_LOCK)),
    reset: vi.fn(() => Promise.resolve()),
  };
  const audit = {
    record: vi.fn<(event: unknown) => void>(),
    turnedAway: vi.fn<(route: string, context: unknown, locked: boolean) => void>(),
  };
  const audiences = { audiencesFor: vi.fn(() => Promise.resolve(new Set(['staff' as const]))) };
  const lastSignIn = {
    stamp: vi.fn((_id: string, _at: Date) => Promise.resolve()),
    clearForcedPasswordChange: vi.fn((_id: string) => Promise.resolve()),
  };
  const deps = { origin: ORIGIN, lockout, audit, audiences, lastSignIn, now: () => NOW };
  const internalAdapter = {
    updateUser: vi.fn(() => Promise.resolve()),
    findUserByEmail: vi.fn(() => Promise.resolve({ user: { id: USER_ID } })),
    deleteSession: vi.fn((_token: string) => Promise.resolve()),
  };
  const context = (
    path: string,
    options: {
      method?: string;
      origin?: string;
      body?: unknown;
      returned?: unknown;
      newSession?: {
        user: { id: string; twoFactorEnabled?: boolean };
        session?: { token: string };
      } | null;
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
    audiences,
    lastSignIn,
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
    expect(lockout.takeSlot).not.toHaveBeenCalled();
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

    it('keys the lock on the lowercase email and the client address', async () => {
      const { before, context, lockout } = setup();

      await before(
        context('/sign-in/email', {
          origin: ORIGIN,
          body: { email: 'Sam@Example.COM', password: 'x' },
        }),
      );

      expect(lockout.takeSlot).toHaveBeenCalledWith('sam@example.com', '203.0.113.7');
    });

    it.each([
      ['no email', { password: 'Correct-Horse-1' }],
      ['no password', { email: 'sam@example.com' }],
      ['a password that is not text', { email: 'sam@example.com', password: 12345678 }],
      [
        'a password one past the maximum',
        { email: 'sam@example.com', password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) },
      ],
      ['an email Better Auth refuses', { email: 'not an email', password: 'Correct-Horse-1' }],
      [
        'an email with spaces around it',
        { email: ' sam@example.com ', password: 'Correct-Horse-1' },
      ],
      [
        'a remember me that is not true or false',
        { email: 'sam@example.com', password: 'Correct-Horse-1', rememberMe: 'yes' },
      ],
      ['no body', undefined],
    ])(
      'leaves a body with %s to Better Auth, taking no slot and hashing nothing, locked or not',
      async (_name, body) => {
        for (const locked of [false, true]) {
          const { before, context, lockout, audit } = setup({ locked });

          await expect(
            before(context('/sign-in/email', { origin: ORIGIN, body })),
          ).resolves.toBeUndefined();

          expect(lockout.takeSlot).not.toHaveBeenCalled();
          expect(audit.record).not.toHaveBeenCalled();
        }
        expect(hashPassword).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['the maximum length', 'x'.repeat(PASSWORD_MAX_LENGTH)],
      // Better Auth's sign in sets no minimum, so a short password is checked and must count.
      ['one character', 'x'],
    ])('takes a slot for a password of %s', async (_name, password) => {
      const { before, context, lockout } = setup();

      await before(
        context('/sign-in/email', {
          origin: ORIGIN,
          body: { email: 'sam@example.com', password, rememberMe: false, callbackURL: '/stock' },
        }),
      );

      expect(lockout.takeSlot).toHaveBeenCalledTimes(1);
    });

    it('answers a full window (no free slot, no lock) like a lock, holding no slot', async () => {
      // Better Auth runs no after hook once a before hook throws, so nothing is counted.
      const { before, context, lockout, audit } = setup();
      lockout.takeSlot.mockResolvedValueOnce({ slot: null, locked: false });
      const body = { email: 'sam@example.com', password: 'x' };

      const error = await before(context('/sign-in/email', { origin: ORIGIN, body })).catch(
        (e: unknown) => e,
      );

      expect((error as APIError).statusCode).toBe(401);
      expect((error as APIError).body).toEqual(wrongPassword().body);
      expect(audit.record.mock.calls[0]?.[0]).toMatchObject({ reason: 'locked' });
      // A password is hashed once, as a real attempt would, so timing cannot tell this answer.
      expect(hashPassword).toHaveBeenCalledTimes(1);
      expect(hashPassword).toHaveBeenCalledWith('x');
      expect(lockout.giveBack).not.toHaveBeenCalled();
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

type SignInResult = {
  returned?: unknown;
  responseHeaders?: Headers;
  newSession?: { user: { id: string; twoFactorEnabled?: boolean }; session?: { token: string } };
};

/** Runs the before hook, which takes the slot, then the after hook with Better Auth's result. */
async function attempt(
  s: ReturnType<typeof setup>,
  result: SignInResult,
  email = 'Sam@Example.com',
) {
  const ctx = s.context('/sign-in/email', { origin: ORIGIN, body: { email, password: 'x' } });
  await s.before(ctx);
  await s.after({ ...ctx, context: { ...ctx.context, ...result } });
}

/** The one `SignInRefused` line a no hat refusal writes: ids, address and user agent only. */
function expectRefusalLogged(log: { mock: { calls: unknown[][] } }): void {
  const lines = log.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('SignInRefused'));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '{}')).toEqual({
    event: 'SignInRefused',
    reason: 'no_access',
    actorId: USER_ID,
    ip: '203.0.113.7',
    userAgent: null,
    at: NOW.toISOString(),
  });
}

const FAILURE = { emailKey: 'sam@example.com', ip: '203.0.113.7' };

describe('after hook', () => {
  describe('a person with no hat (spec 0008, AC-10)', () => {
    const issued = { user: { id: USER_ID }, session: { token: 'tok' } };

    it('is refused with 403 NO_ACCESS after a right password: session deleted, nothing recorded, slot back', async () => {
      const s = setup();
      s.audiences.audiencesFor.mockResolvedValueOnce(new Set());
      const responseHeaders = new Headers({ 'set-cookie': 'session_token=tok; Path=/' });
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      const error = await attempt(s, {
        newSession: issued,
        returned: { token: 'tok' },
        responseHeaders,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).statusCode).toBe(403);
      expect((error as APIError).body).toMatchObject({ code: 'NO_ACCESS' });
      expect(s.internalAdapter.deleteSession).toHaveBeenCalledWith('tok');
      expect(responseHeaders.get('set-cookie')).toBeNull();
      expect(s.internalAdapter.updateUser).not.toHaveBeenCalled();
      expect(s.audit.record).not.toHaveBeenCalled();
      expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT);
      expectRefusalLogged(log);
      log.mockRestore();
    });

    it('never asks about hats before the password: a wrong password answers as for anyone', async () => {
      const s = setup();

      await attempt(s, { returned: wrongPassword() });

      expect(s.audiences.audiencesFor).not.toHaveBeenCalled();
      expect(s.internalAdapter.deleteSession).not.toHaveBeenCalled();
    });

    it('lets a person with a hat sign in as before', async () => {
      const s = setup();

      await attempt(s, { newSession: issued, returned: { token: 'tok' } });

      expect(s.audiences.audiencesFor).toHaveBeenCalledWith(USER_ID);
      expect(s.internalAdapter.deleteSession).not.toHaveBeenCalled();
      expect(s.audit.record).toHaveBeenCalledWith(expect.any(SignedIn));
    });

    it('waits for the code when two factor is on, and refuses then', async () => {
      const s = setup();
      s.audiences.audiencesFor.mockResolvedValue(new Set());

      await attempt(s, {
        newSession: { ...issued, user: { id: USER_ID, twoFactorEnabled: true } },
        returned: { token: 'tok' },
      });

      expect(s.audiences.audiencesFor).not.toHaveBeenCalled();
    });
  });

  it('on a full session: stamps the last sign in, clears the counters, emits SignedIn', async () => {
    const s = setup();

    await attempt(s, { newSession: { user: { id: USER_ID } }, returned: { token: 't' } });

    expect(s.lastSignIn.stamp).toHaveBeenCalledWith(USER_ID, NOW);
    // Better Auth's updateUser also sets updated_at, the stale record token (spec 0008 AC-12).
    expect(s.internalAdapter.updateUser).not.toHaveBeenCalled();
    expect(s.lockout.reset).toHaveBeenCalledWith('sam@example.com');
    expect(s.audit.record).toHaveBeenCalledWith(expect.any(SignedIn));
    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT);
  });

  it('with two factor on, the password step is not a sign in: nothing is stamped, cleared or recorded (AC-3, AC-23)', async () => {
    const s = setup();

    await attempt(s, {
      newSession: { user: { id: USER_ID, twoFactorEnabled: true } },
      returned: { twoFactorRedirect: true },
    });

    expect(s.internalAdapter.updateUser).not.toHaveBeenCalled();
    expect(s.lockout.reset).not.toHaveBeenCalled();
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('on a wrong password: counts the failure and emits SignInFailed', async () => {
    const s = setup();

    await attempt(s, { returned: wrongPassword() });

    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT, FAILURE);
    expect(s.lockout.reset).not.toHaveBeenCalled();
    expect(s.internalAdapter.updateUser).not.toHaveBeenCalled();
    expect(s.audit.record.mock.calls[0]?.[0]).toMatchObject({ reason: 'bad_credentials' });
  });

  it('emits AccountLocked once for the lock a failure started', async () => {
    const s = setup();
    s.lockout.giveBack.mockResolvedValueOnce({ pairLocked: true, emailLocked: false });

    await attempt(s, { returned: wrongPassword() });

    const events = s.audit.record.mock.calls.map((call) => call[0]);
    expect(events.filter((event) => event instanceof AccountLocked)).toHaveLength(1);
    expect(events[1]).toMatchObject({ scope: 'pair' });
  });

  it('a disabled account with the right password is neither a failure nor a reset', async () => {
    const s = setup();
    const banned = APIError.from('FORBIDDEN', { code: 'BANNED_USER', message: 'disabled' });

    await attempt(s, { returned: banned });

    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT);
    expect(s.lockout.reset).not.toHaveBeenCalled();
    expect(s.audit.record.mock.calls[0]?.[0]).toMatchObject({ reason: 'disabled' });
  });

  it('does not count an error that is not a credential failure', async () => {
    const s = setup();
    const invalid = APIError.from('BAD_REQUEST', { code: 'VALIDATION_ERROR', message: 'bad body' });

    await attempt(s, { returned: invalid });

    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT);
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('records an unknown email with no target, so it looks like a real one in the counters', async () => {
    const s = setup();
    s.internalAdapter.findUserByEmail.mockResolvedValue(null as never);

    await attempt(s, { returned: wrongPassword() }, 'nobody@example.com');

    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT, {
      emailKey: 'nobody@example.com',
      ip: '203.0.113.7',
    });
    expect(s.audit.record.mock.calls[0]?.[0]).toMatchObject({ context: { targetId: null } });
  });

  it('counts nothing for a failure that holds no slot', async () => {
    // Cannot happen over HTTP: a request turned away in the before hook never reaches here.
    const s = setup();

    await s.after(
      s.context('/sign-in/email', {
        body: { email: 'sam@example.com' },
        returned: wrongPassword(),
      }),
    );

    expect(s.lockout.giveBack).not.toHaveBeenCalled();
  });
});

describe('sign in slots (AC-3)', () => {
  it('gives the slot back and counts a wrong password in the same call', async () => {
    const s = setup();
    s.lockout.giveBack.mockResolvedValueOnce({ pairLocked: true, emailLocked: false });

    await attempt(s, { returned: wrongPassword() });

    expect(s.lockout.giveBack).toHaveBeenCalledTimes(1);
    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT, FAILURE);
    const events = s.audit.record.mock.calls.map((call) => call[0]);
    expect(events.filter((event) => event instanceof AccountLocked)).toHaveLength(1);
  });

  it.each([
    ['a full sign in', { newSession: { user: { id: USER_ID } }, returned: { token: 't' } }],
    [
      'a password step waiting for a second factor',
      {
        newSession: { user: { id: USER_ID, twoFactorEnabled: true } },
        returned: { twoFactorRedirect: true },
      },
    ],
    [
      'a disabled account',
      { returned: APIError.from('FORBIDDEN', { code: 'BANNED_USER', message: 'disabled' }) },
    ],
    [
      'any other error',
      { returned: APIError.from('BAD_REQUEST', { code: 'VALIDATION_ERROR', message: 'bad' }) },
    ],
  ])('gives the slot back without counting after %s', async (_name, result) => {
    const s = setup();

    await attempt(s, result);

    expect(s.lockout.giveBack).toHaveBeenCalledTimes(1);
    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT);
  });

  it('gives the slot back even when the after hook fails partway', async () => {
    const s = setup();
    s.lastSignIn.stamp.mockRejectedValueOnce(new Error('database down'));

    await expect(
      attempt(s, { newSession: { user: { id: USER_ID } }, returned: { token: 't' } }),
    ).rejects.toThrow('database down');

    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT);
  });

  it('reports the first error when giving the slot back also fails', async () => {
    const s = setup();
    s.lastSignIn.stamp.mockRejectedValueOnce(new Error('database down'));
    s.lockout.giveBack.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(
      attempt(s, { newSession: { user: { id: USER_ID } }, returned: { token: 't' } }),
    ).rejects.toThrow('database down');
  });

  it('reports a failed give back when nothing else went wrong', async () => {
    const s = setup();
    s.lockout.giveBack.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(
      attempt(s, { newSession: { user: { id: USER_ID } }, returned: { token: 't' } }),
    ).rejects.toThrow('pool exhausted');
  });
});

/** A signed in person, as `getSessionFromCtx` reads them. */
function signedIn() {
  vi.mocked(getSessionFromCtx).mockResolvedValue({
    session: { createdAt: NOW, token: 'session-token' },
    user: { id: USER_ID, email: 'Sam@Example.com', twoFactorEnabled: false },
  } as never);
}

const invalidPassword = () =>
  APIError.from('BAD_REQUEST', { code: 'INVALID_PASSWORD', message: 'Invalid password' });

describe('routes that ask for the current password (AC-3)', () => {
  const body = { currentPassword: 'x', newPassword: 'New-Pass-123' };

  it.each(['/change-password', '/two-factor/disable'])(
    'on %s, gives the slot back and counts a wrong password in the same call',
    async (path) => {
      const s = setup();
      signedIn();
      const ctx = s.context(path, { origin: ORIGIN, body });

      await s.before(ctx);
      await s.after({ ...ctx, context: { ...ctx.context, returned: invalidPassword() } });

      expect(s.lockout.takeSlot).toHaveBeenCalledWith('sam@example.com', '203.0.113.7');
      expect(s.lockout.giveBack).toHaveBeenCalledTimes(1);
      expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT, FAILURE);
    },
  );

  it('gives the slot back without counting after a good change', async () => {
    const s = setup();
    signedIn();
    const ctx = s.context('/change-password', { origin: ORIGIN, body });

    await s.before(ctx);
    await s.after({ ...ctx, context: { ...ctx.context, returned: { status: true } } });

    expect(s.lastSignIn.clearForcedPasswordChange).toHaveBeenCalledWith(USER_ID);
    // Better Auth's updateUser also sets updated_at, the stale record token (spec 0008 AC-12).
    expect(s.internalAdapter.updateUser).not.toHaveBeenCalled();
    expect(s.lockout.giveBack).toHaveBeenCalledTimes(1);
    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT);
  });

  it('answers a full window like a wrong password (400 INVALID_PASSWORD), counting nothing', async () => {
    const s = setup();
    signedIn();
    s.lockout.takeSlot.mockResolvedValueOnce({ slot: null, locked: false });

    const error = await s
      .before(s.context('/two-factor/disable', { origin: ORIGIN, body }))
      .catch((e: unknown) => e);

    expect((error as APIError).statusCode).toBe(400);
    expect((error as APIError).body).toMatchObject({ code: 'INVALID_PASSWORD' });
    expect(s.lockout.giveBack).not.toHaveBeenCalled();
    // AC-23 has no event for it: one log line with the ids, and no event.
    expect(s.audit.record).not.toHaveBeenCalled();
    expect(s.audit.turnedAway).toHaveBeenCalledTimes(1);
    expect(s.audit.turnedAway).toHaveBeenCalledWith(
      '/two-factor/disable',
      expect.objectContaining({ actorId: USER_ID, targetId: USER_ID, ip: '203.0.113.7' }),
      false,
    );
  });

  it('logs a turn away while locked with the lock named', async () => {
    const s = setup({ locked: true });
    signedIn();

    await expect(
      s.before(s.context('/change-password', { origin: ORIGIN, body })),
    ).rejects.toMatchObject({ body: { code: 'INVALID_PASSWORD' } });

    expect(s.audit.turnedAway).toHaveBeenCalledWith(
      '/change-password',
      expect.objectContaining({ actorId: USER_ID }),
      true,
    );
  });
});

describe('second factor codes (AC-3, AC-20)', () => {
  const CHALLENGE = 'challenge-1';
  const PATH = '/two-factor/verify-totp';
  const wrongCode = () =>
    APIError.from('UNAUTHORIZED', { code: 'INVALID_CODE', message: 'Invalid code' });

  /** A code for a sign in waiting on its second factor, found through the signed cookie. */
  function pending(s: ReturnType<typeof setup>) {
    const consumeVerificationValue = vi.fn(() => Promise.resolve());
    const base = s.context(PATH, { origin: ORIGIN, body: { code: '000000' } });
    const ctx: HookContext = {
      ...base,
      getSignedCookie: vi.fn(() => Promise.resolve(CHALLENGE)),
      context: {
        ...base.context,
        secret: 'secret',
        createAuthCookie: (name: string) => ({ name }),
        internalAdapter: {
          ...s.internalAdapter,
          findVerificationValue: vi.fn(() => Promise.resolve({ value: USER_ID })),
          findUserById: vi.fn(() => Promise.resolve({ id: USER_ID, email: 'Sam@Example.com' })),
          consumeVerificationValue,
        },
      },
    };
    return { ctx, consumeVerificationValue };
  }

  it('gives the slot back and counts a wrong code in the same call', async () => {
    const s = setup();
    const { ctx, consumeVerificationValue } = pending(s);

    await s.before(ctx);
    await s.after({ ...ctx, context: { ...ctx.context, returned: wrongCode() } });

    expect(s.lockout.giveBack).toHaveBeenCalledTimes(1);
    expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT, FAILURE);
    expect(consumeVerificationValue).not.toHaveBeenCalled();
  });

  it.each(['/two-factor/verify-totp', '/two-factor/verify-backup-code'])(
    'refuses a right code on %s for a person with no hat: 403 NO_ACCESS, session deleted, cookie removed, slot back, line logged (AC-10)',
    async (path) => {
      const s = setup();
      s.audiences.audiencesFor.mockResolvedValueOnce(new Set());
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { ctx } = pending(s);
      const responseHeaders = new Headers({ 'set-cookie': 'session_token=tok; Path=/' });
      const codeCtx: HookContext = { ...ctx, path };

      await s.before(codeCtx);
      const error = await s
        .after({
          ...codeCtx,
          context: {
            ...codeCtx.context,
            returned: { token: 'tok' },
            newSession: { user: { id: USER_ID }, session: { token: 'tok' } },
            responseHeaders,
          },
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).statusCode).toBe(403);
      expect((error as APIError).body).toMatchObject({ code: 'NO_ACCESS' });
      expect(s.internalAdapter.deleteSession).toHaveBeenCalledWith('tok');
      expect(responseHeaders.get('set-cookie')).toBeNull();
      expect(s.lockout.giveBack).toHaveBeenCalledWith(SLOT);
      expect(s.lockout.reset).not.toHaveBeenCalled();
      expect(s.audit.record).not.toHaveBeenCalled();
      expectRefusalLogged(log);
      log.mockRestore();
    },
  );

  it('ends the pending sign in when the counted wrong code starts a lock', async () => {
    const s = setup();
    const { ctx, consumeVerificationValue } = pending(s);
    s.lockout.giveBack.mockResolvedValueOnce({ pairLocked: true, emailLocked: false });

    await s.before(ctx);
    await s.after({ ...ctx, context: { ...ctx.context, returned: wrongCode() } });

    expect(consumeVerificationValue).toHaveBeenCalledWith(CHALLENGE);
  });

  it('turns a code away in a full window (locked: false) without ending the pending sign in', async () => {
    const s = setup();
    const { ctx, consumeVerificationValue } = pending(s);
    s.lockout.takeSlot.mockResolvedValueOnce({ slot: null, locked: false });

    await expect(s.before(ctx)).rejects.toMatchObject({
      statusCode: 401,
      body: { code: 'INVALID_CODE' },
    });
    expect(consumeVerificationValue).not.toHaveBeenCalled();
    expect(s.lockout.giveBack).not.toHaveBeenCalled();
    // Recorded like a turned away sign in.
    expect(s.audit.record).toHaveBeenCalledTimes(1);
    expect(s.audit.record.mock.calls[0]?.[0]).toBeInstanceOf(SignInFailed);
    expect(s.audit.record.mock.calls[0]?.[0]).toMatchObject({
      reason: 'locked',
      context: { actorId: null, targetId: USER_ID, ip: '203.0.113.7' },
    });
    expect(s.audit.turnedAway).not.toHaveBeenCalled();
  });

  it('logs a first code turned away while turning two factor on, with no sign in event', async () => {
    const s = setup();
    signedIn();
    s.lockout.takeSlot.mockResolvedValueOnce({ slot: null, locked: false });

    await expect(
      s.before(s.context(PATH, { origin: ORIGIN, body: { code: '000000' } })),
    ).rejects.toMatchObject({ statusCode: 401, body: { code: 'INVALID_CODE' } });

    expect(s.audit.record).not.toHaveBeenCalled();
    expect(s.audit.turnedAway).toHaveBeenCalledWith(
      PATH,
      expect.objectContaining({ actorId: USER_ID, targetId: USER_ID }),
      false,
    );
  });

  it('turns a code away while locked (locked: true) and ends the pending sign in', async () => {
    const s = setup({ locked: true });
    const { ctx, consumeVerificationValue } = pending(s);

    await expect(s.before(ctx)).rejects.toMatchObject({
      statusCode: 401,
      body: { code: 'INVALID_CODE' },
    });
    expect(consumeVerificationValue).toHaveBeenCalledWith(CHALLENGE);
    expect(consumeVerificationValue).toHaveBeenCalledWith(`2fa-attempts-${CHALLENGE}`);
    expect(s.lockout.giveBack).not.toHaveBeenCalled();
  });
});

describe('password reset request (AC-9)', () => {
  function resetSetup(found: { user: { id: string } } | null) {
    let clock = NOW.getTime();
    const sleep = vi.fn((ms: number) => {
      clock += ms;
      return Promise.resolve();
    });
    const audit = {
      record: vi.fn<(event: unknown) => void>(),
      turnedAway: vi.fn<(route: string, context: unknown, locked: boolean) => void>(),
    };
    const deps = {
      origin: ORIGIN,
      lockout: { takeSlot: vi.fn(), giveBack: vi.fn(), reset: vi.fn() },
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
