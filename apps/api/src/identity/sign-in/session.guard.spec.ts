import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import type { Auth } from './auth.tokens.js';
import { Audience, type AudienceName } from '../../platform/audience/audience.decorator.js';
import type { SessionAudience, SessionAudiences } from '../sessions/session-audiences.js';
import { IS_PUBLIC } from './public.decorator.js';
import { SessionGuard } from './session.guard.js';

const ORIGIN = 'https://erp.example.com';
const env = { PUBLIC_URL: `${ORIGIN}` } as Env;

const liveSession = (createdAt = new Date()) => ({ id: 's1', token: 't1', createdAt });

const USER = {
  id: '0190c0de-0000-7000-8000-000000000001',
  name: 'Sam',
  email: 'sam@example.com',
  role: 'admin',
  banned: false,
  mustChangePassword: false,
  twoFactorEnabled: false,
  phone: null,
  staffCode: null,
  language: 'ar',
};

function setup(options: {
  method?: string;
  path?: string;
  origin?: string;
  cookie?: string;
  isPublic?: boolean;
  audience?: AudienceName;
  session?: { user: typeof USER; session: { id: string; token: string; createdAt: Date } } | null;
  setCookies?: string[];
  /** What the fake `SessionAudiences` answers; `staff` when not given. */
  audiences?: SessionAudience[];
}) {
  const getSession = vi.fn(() =>
    Promise.resolve({
      response: options.session ?? null,
      headers: new Headers(
        (options.setCookies ?? []).map((value) => ['set-cookie', value] as [string, string]),
      ),
    }),
  );
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
    key === IS_PUBLIC ? options.isPublic : undefined,
  );
  class Controller {}
  if (options.audience) Audience(options.audience)(Controller);
  const request = {
    method: options.method ?? 'GET',
    path: options.path ?? '/api/things',
    headers: { ...(options.origin && { origin: options.origin }), cookie: options.cookie },
  } as Record<string, unknown>;
  const response = { append: vi.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => undefined,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
  const deleteSession = vi.fn(() => Promise.resolve());
  const deleteUserSessions = vi.fn(() => Promise.resolve());
  const auth = {
    api: { getSession },
    $context: Promise.resolve({ internalAdapter: { deleteSession, deleteUserSessions } }),
  } as unknown as Auth;
  const audiencesFor = vi.fn(() =>
    Promise.resolve(new Set<SessionAudience>(options.audiences ?? ['staff'])),
  );
  const audiences = { audiencesFor } as unknown as SessionAudiences;
  const guard = new SessionGuard(reflector, auth, env, audiences);
  return {
    guard,
    context,
    request,
    response,
    getSession,
    deleteSession,
    deleteUserSessions,
    audiencesFor,
  };
}

describe('SessionGuard', () => {
  it('lets a public audience through without asking Better Auth, even without @Public()', async () => {
    const { guard, context, getSession } = setup({ audience: 'public' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('still requires a session on a staff audience', async () => {
    const { guard, context } = setup({ audience: 'staff' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'UNAUTHENTICATED' },
    });
  });

  it('still requires a session on a partner audience', async () => {
    const { guard, context } = setup({
      audience: 'partner',
      cookie: 'better-auth.session_token=x',
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'SESSION_EXPIRED' },
    });
  });

  it('lets a public route through without asking Better Auth', async () => {
    const { guard, context, getSession } = setup({ isPublic: true });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('answers UNAUTHENTICATED when there is no cookie and no session', async () => {
    const { guard, context } = setup({});

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'UNAUTHENTICATED' },
    });
  });

  it.each([
    ['a plain cookie', 'better-auth.session_token=abc.def'],
    ['the https cookie', '__Secure-better-auth.session_token=abc.def'],
    ['one among others', 'theme=dark; better-auth.session_token=abc.def; ss_lang=ar'],
  ])('answers SESSION_EXPIRED when %s has no live session behind it', async (_case, cookie) => {
    const { guard, context } = setup({ cookie });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'SESSION_EXPIRED' },
    });
  });

  it('does not mistake a look alike cookie name for the session cookie', async () => {
    const { guard, context } = setup({ cookie: 'x-better-auth.session_token=abc' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'UNAUTHENTICATED' },
    });
  });

  it('treats a disabled person as signed out even when the session row is live', async () => {
    const { guard, context } = setup({
      cookie: 'better-auth.session_token=abc',
      session: { user: { ...USER, banned: true }, session: liveSession() },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'SESSION_EXPIRED' },
    });
  });

  it('attaches the person and passes a renewed cookie on', async () => {
    const { guard, context, request, response } = setup({
      cookie: 'better-auth.session_token=abc',
      session: { user: USER, session: liveSession() },
      setCookies: ['better-auth.session_token=renewed; Path=/; HttpOnly'],
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.staff).toEqual({
      id: USER.id,
      name: 'Sam',
      email: 'sam@example.com',
      role: 'admin',
      phone: null,
      staffCode: null,
      language: 'ar',
      twoFactorEnabled: false,
      mustChangePassword: false,
      home: 'backoffice',
      sessionId: 's1',
    });
    expect(response.append).toHaveBeenCalledWith(
      'set-cookie',
      'better-auth.session_token=renewed; Path=/; HttpOnly',
    );
  });

  describe('a temporary password that must be changed (AC-14)', () => {
    const forced = { ...USER, mustChangePassword: true };
    const run = (method: string, path: string) =>
      setup({
        method,
        path,
        origin: ORIGIN,
        cookie: 'better-auth.session_token=abc',
        session: { user: forced, session: liveSession() },
      });

    it('lets only GET /api/me through', async () => {
      const { guard, context } = run('GET', '/api/me');

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it.each([
      ['GET', '/api/locations'],
      ['GET', '/api/staff'],
      ['POST', '/api/staff'],
      ['PATCH', '/api/me'],
      ['POST', '/api/me'],
    ])('answers 403 PASSWORD_CHANGE_REQUIRED to %s %s', async (method, path) => {
      const { guard, context } = run(method, path);

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'PASSWORD_CHANGE_REQUIRED' },
      });
    });

    it('does not gate a person with no forced change', async () => {
      const { guard, context } = setup({
        path: '/api/locations',
        cookie: 'better-auth.session_token=abc',
        session: { user: USER, session: liveSession() },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('the 7 day cap (AC-5)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const withAge = (ms: number) =>
      setup({
        cookie: 'better-auth.session_token=abc',
        session: { user: USER, session: liveSession(new Date(Date.now() - ms)) },
        setCookies: ['better-auth.session_token=renewed; Path=/'],
      });

    it('lets a session just under 7 days old through', async () => {
      const { guard, context, deleteSession } = withAge(7 * DAY - 60_000);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(deleteSession).not.toHaveBeenCalled();
    });

    it('ends a session older than 7 days even though it was just used', async () => {
      const { guard, context, deleteSession, response } = withAge(7 * DAY + 60_000);

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'SESSION_EXPIRED' },
      });
      expect(deleteSession).toHaveBeenCalledWith('t1');
      expect(response.append).not.toHaveBeenCalled();
    });
  });

  it('reports whether two factor is on, from the account', async () => {
    const { guard, context, request } = setup({
      cookie: 'better-auth.session_token=abc',
      session: { user: { ...USER, twoFactorEnabled: true }, session: liveSession() },
    });

    await guard.canActivate(context);

    expect(request.staff).toMatchObject({ twoFactorEnabled: true });
  });

  it('falls back to the staff role for a role it does not know', async () => {
    const { guard, context, request } = setup({
      cookie: 'better-auth.session_token=abc',
      session: { user: { ...USER, role: 'owner' }, session: liveSession() },
    });

    await guard.canActivate(context);

    expect(request.staff).toMatchObject({ role: 'staff' });
  });

  describe('the Origin check on writes', () => {
    it.each([['POST'], ['PATCH'], ['DELETE']])('rejects a %s from another site', async (method) => {
      const { guard, context } = setup({ method, origin: 'https://evil.example', isPublic: true });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a write with no Origin header', async () => {
      const { guard, context } = setup({ method: 'POST', isPublic: true });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'FORBIDDEN_ORIGIN' },
      });
    });

    it('accepts a write from our own origin', async () => {
      const { guard, context } = setup({ method: 'POST', origin: ORIGIN, isPublic: true });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('does not ask a read for an Origin', async () => {
      const { guard, context } = setup({ method: 'GET', isPublic: true });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('the audience of the route (AC-29)', () => {
    const signedIn = (audience: AudienceName, audiences: SessionAudience[], method = 'GET') =>
      setup({
        audience,
        audiences,
        method,
        origin: ORIGIN,
        cookie: 'better-auth.session_token=abc',
        session: { user: USER, session: liveSession() },
      });

    it.each<AudienceName>(['portal', 'hook'])(
      'never reads the cookie on a %s route, even a valid staff one, and puts no one on the request',
      async (audience) => {
        const { guard, context, request, getSession, audiencesFor } = signedIn(audience, ['staff']);

        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(getSession).not.toHaveBeenCalled();
        expect(audiencesFor).not.toHaveBeenCalled();
        expect(request.staff).toBeUndefined();
        expect(request.partner).toBeUndefined();
      },
    );

    it.each<AudienceName>(['portal', 'hook'])(
      'leaves the Origin of a write on a %s route to that route',
      async (audience) => {
        const { guard, context } = setup({ audience, method: 'POST', origin: 'https://shop.test' });

        await expect(guard.canActivate(context)).resolves.toBe(true);
      },
    );

    it('answers 403 WRONG_AUDIENCE to a staff session on a partner route', async () => {
      const { guard, context, request } = signedIn('partner', ['staff']);

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'WRONG_AUDIENCE' },
      });
      expect(request.staff).toBeUndefined();
      expect(request.partner).toBeUndefined();
    });

    it('answers 403 WRONG_AUDIENCE to a partner session on a staff route', async () => {
      const { guard, context, request } = signedIn('staff', ['partner']);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'WRONG_AUDIENCE' },
      });
      expect(request.staff).toBeUndefined();
    });

    it('holds a controller with no audience to the staff rule', async () => {
      const { guard, context } = setup({
        cookie: 'better-auth.session_token=abc',
        session: { user: USER, session: liveSession() },
        audiences: ['partner'],
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'WRONG_AUDIENCE' },
      });
    });

    it('puts a partner user on request.partner, never on request.staff, with home partner', async () => {
      const { guard, context, request } = signedIn('partner', ['partner']);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.staff).toBeUndefined();
      expect(request.partner).toMatchObject({ id: USER.id, home: 'partner', sessionId: 's1' });
    });

    it('asks SessionAudiences on every request, with the person from the session', async () => {
      const { guard, context, audiencesFor } = signedIn('staff', ['staff']);

      await guard.canActivate(context);
      await guard.canActivate(context);

      expect(audiencesFor).toHaveBeenCalledTimes(2);
      expect(audiencesFor).toHaveBeenCalledWith(USER.id);
    });

    it.each<AudienceName>(['staff', 'partner'])(
      'ends every session of a person with no hat left, on a %s route',
      async (audience) => {
        const { guard, context, deleteUserSessions, request } = signedIn(audience, []);

        await expect(guard.canActivate(context)).rejects.toMatchObject({
          response: { code: 'SESSION_EXPIRED' },
        });
        expect(deleteUserSessions).toHaveBeenCalledWith(USER.id);
        expect(request.staff).toBeUndefined();
      },
    );

    it('checks the Origin of a write on a partner route', async () => {
      const { guard, context, getSession } = setup({
        audience: 'partner',
        method: 'POST',
        origin: 'https://evil.example',
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'FORBIDDEN_ORIGIN' },
      });
      expect(getSession).not.toHaveBeenCalled();
    });

    it('treats a disabled partner user as signed out', async () => {
      const { guard, context } = setup({
        audience: 'partner',
        audiences: ['partner'],
        cookie: 'better-auth.session_token=abc',
        session: { user: { ...USER, banned: true }, session: liveSession() },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'SESSION_EXPIRED' },
      });
    });

    it('caps a partner session at 7 days', async () => {
      const { guard, context, deleteSession } = setup({
        audience: 'partner',
        audiences: ['partner'],
        cookie: 'better-auth.session_token=abc',
        session: { user: USER, session: liveSession(new Date(Date.now() - 8 * 86_400_000)) },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'SESSION_EXPIRED' },
      });
      expect(deleteSession).toHaveBeenCalledWith('t1');
    });

    it.each([
      ['GET', '/api/partner/me', true],
      ['GET', '/api/me', false],
      ['GET', '/api/partner/stock', false],
      ['PATCH', '/api/partner/me', false],
    ] as const)(
      'lets a partner user with a temporary password %s %s: %s',
      async (method, path, allowed) => {
        const { guard, context } = setup({
          audience: 'partner',
          audiences: ['partner'],
          method,
          path,
          origin: ORIGIN,
          cookie: 'better-auth.session_token=abc',
          session: { user: { ...USER, mustChangePassword: true }, session: liveSession() },
        });

        if (allowed) await expect(guard.canActivate(context)).resolves.toBe(true);
        else {
          await expect(guard.canActivate(context)).rejects.toMatchObject({
            response: { code: 'PASSWORD_CHANGE_REQUIRED' },
          });
        }
      },
    );
  });
});
