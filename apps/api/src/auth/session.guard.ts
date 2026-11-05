import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole, type SessionErrorCode } from '@ssdashboard/contracts';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { CurrentStaff } from './current-staff.js';
import { audienceOf } from '../platform/audience/audience.decorator.js';
import { IS_PUBLIC } from './public.decorator.js';
import { AUTH, type Auth } from './auth.tokens.js';
import { pastAbsoluteCap } from './session-policy.js';

/** Better Auth's session cookie, with or without the `__Secure-` prefix it uses over https. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The one guard on every `/api` route (spec 0005, AC-7). It rejects a write whose `Origin` is
 * not ours, lets `@Audience('public')` (and `@Public()`) routes through, and otherwise requires a
 * live session. The person is read from the database on every request, so a disabled account
 * fails on its next call.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly origin: string;

  /**
   * Takes the reflector for route metadata, the Better Auth instance, and the env for the
   * trusted origin.
   */
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(ENV) env: Env,
  ) {
    this.origin = new URL(env.PUBLIC_URL).origin;
  }

  /**
   * Applies the origin check, the public route exemption and the session lookup. Throws 401 or
   * 403 with a stable code, and puts the person on `request.staff` on success.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { staff?: CurrentStaff }>();
    const response = http.getResponse<Response>();

    // Beyond SameSite=Lax: a write from another site must never carry our cookie's authority.
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== this.origin) {
      throw new ForbiddenException({ code: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' });
    }

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getClass(),
    ]);
    // Class level only, on purpose: a handler can never open itself up inside a guarded controller.
    // The audience is the source of truth; `@Public()` stays honoured and a spec keeps them equal.
    if (isPublic || audienceOf(context.getClass()) === 'public') return true;

    const result = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    const found = result.response;
    if (!found || found.user.banned) {
      throw this.unauthenticated(SESSION_COOKIE.test(request.headers.cookie ?? ''));
    }

    // Never longer than 7 days from sign in, however recently it was used (AC-5). The row is
    // removed so the old cookie keeps failing, and the answer is the same as for any ended session.
    if (pastAbsoluteCap(found.session.createdAt)) {
      const { internalAdapter } = await this.auth.$context;
      await internalAdapter.deleteSession(found.session.token);
      throw this.unauthenticated(true);
    }

    // A used session renews its cookie (at most hourly); pass Better Auth's Set-Cookie on.
    for (const cookie of result.headers.getSetCookie()) response.append('set-cookie', cookie);

    const { user, session } = found;
    request.staff = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: StaffRole.catch('staff').parse(user.role),
      phone: user.phone ?? null,
      staffCode: user.staffCode ?? null,
      language: user.language ?? null,
      twoFactorEnabled: user.twoFactorEnabled ?? false,
      mustChangePassword: user.mustChangePassword,
      sessionId: session.id,
    };

    // A temporary password must be changed first (AC-14): only "who am I" works until then. Change
    // password and sign out are Better Auth routes, which their own before hook lets through.
    if (user.mustChangePassword && !(request.method === 'GET' && request.path === '/api/me')) {
      throw new ForbiddenException({
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Change your password to continue.',
      });
    }
    return true;
  }

  /** A cookie with no live session behind it is `SESSION_EXPIRED`; no cookie is `UNAUTHENTICATED`. */
  private unauthenticated(hadCookie: boolean): UnauthorizedException {
    const code: SessionErrorCode = hadCookie ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED';
    return new UnauthorizedException({
      code,
      message: hadCookie ? 'Your session has ended. Sign in again.' : 'Sign in to continue.',
    });
  }
}
