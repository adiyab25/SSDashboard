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
import { IS_PUBLIC } from './public.decorator.js';
import { AUTH, type Auth } from './auth.tokens.js';

/** Better Auth's session cookie, with or without the `__Secure-` prefix it uses over https. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The one guard on every `/api` route (spec 0005, AC-7). It rejects a write whose `Origin` is
 * not ours, lets `@Public()` routes through, and otherwise requires a live session. The person
 * is read from the database on every request, so a disabled account fails on its next call.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly origin: string;

  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(ENV) env: Env,
  ) {
    this.origin = new URL(env.PUBLIC_URL).origin;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { staff?: CurrentStaff }>();
    const response = http.getResponse<Response>();

    // Beyond SameSite=Lax: a write from another site must never carry our cookie's authority.
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== this.origin) {
      throw new ForbiddenException({ code: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' });
    }

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const result = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    const found = result.response;
    if (!found || found.user.banned) {
      throw this.unauthenticated(SESSION_COOKIE.test(request.headers.cookie ?? ''));
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
      // The two factor plugin (a later slice) adds this field to the user; none is enrolled yet.
      twoFactorEnabled: false,
      mustChangePassword: user.mustChangePassword,
      sessionId: session.id,
    };
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
