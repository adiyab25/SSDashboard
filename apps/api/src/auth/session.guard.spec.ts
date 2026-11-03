import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import type { Auth } from './auth.tokens.js';
import { IS_PUBLIC } from './public.decorator.js';
import { SessionGuard } from './session.guard.js';

const ORIGIN = 'https://erp.example.com';
const env = { PUBLIC_URL: `${ORIGIN}` } as Env;

const USER = {
  id: '0190c0de-0000-7000-8000-000000000001',
  name: 'Sam',
  email: 'sam@example.com',
  role: 'admin',
  banned: false,
  mustChangePassword: false,
  phone: null,
  staffCode: null,
  language: 'ar',
};

function setup(options: {
  method?: string;
  origin?: string;
  cookie?: string;
  isPublic?: boolean;
  session?: { user: typeof USER; session: { id: string } } | null;
  setCookies?: string[];
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
  const request = {
    method: options.method ?? 'GET',
    headers: { ...(options.origin && { origin: options.origin }), cookie: options.cookie },
  } as Record<string, unknown>;
  const response = { append: vi.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  const guard = new SessionGuard(reflector, { api: { getSession } } as unknown as Auth, env);
  return { guard, context, request, response, getSession };
}

describe('SessionGuard', () => {
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
      session: { user: { ...USER, banned: true }, session: { id: 's1' } },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'SESSION_EXPIRED' },
    });
  });

  it('attaches the person and passes a renewed cookie on', async () => {
    const { guard, context, request, response } = setup({
      cookie: 'better-auth.session_token=abc',
      session: { user: USER, session: { id: 's1' } },
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
      sessionId: 's1',
    });
    expect(response.append).toHaveBeenCalledWith(
      'set-cookie',
      'better-auth.session_token=renewed; Path=/; HttpOnly',
    );
  });

  it('falls back to the staff role for a role it does not know', async () => {
    const { guard, context, request } = setup({
      cookie: 'better-auth.session_token=abc',
      session: { user: { ...USER, role: 'owner' }, session: { id: 's1' } },
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
});
