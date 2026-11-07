import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SessionErrorCode } from '@ssdashboard/contracts';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { ENV } from '../../config/config.module.js';
import { staffOrigin, type Env } from '../../config/env.js';
import type { Access } from '../../platform/access/access.js';
import { forbidden } from '../../platform/access/permission.guard.js';
import { audienceOf } from '../../platform/audience/audience.decorator.js';
import { AccessLoader } from '../access/access-loader.js';
import { audiencesOfHats, homeOf, type SessionAudience } from '../sessions/session-audiences.js';
import type { CurrentPartner, CurrentStaff } from './current-staff.js';
import { IS_PUBLIC } from './public.decorator.js';
import { isWhoAmI } from './who-am-i.decorator.js';
import { AUTH, type Auth } from './auth.tokens.js';
import { pastAbsoluteCap } from './session-policy.js';

/** Better Auth's session cookie, with or without the `__Secure-` prefix it uses over https. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type GuardedRequest = Request & {
  staff?: CurrentStaff;
  partner?: CurrentPartner;
  access?: Access;
};

/**
 * The one guard on every `/api` route (spec 0005, AC-7 and AC-29), audience aware. It reads the
 * route's `@Audience(...)`:
 *
 * - `portal` and `hook` routes are not its to serve: it returns at once and never reads the
 *   session cookie or the Origin, so a staff cookie can never act there. Their own proof (a
 *   sealed token, a signature) comes with their features; until then `AudienceGuard` denies them.
 * - `public` routes (and `@Public()`) pass after the Origin check, without reading the cookie.
 * - `staff` and `partner` routes need a live session whose person may use that audience, as
 *   their hats say on every request (`audiencesOfHats`, the rule `SessionAudiences` answers by);
 *   a live session that does not fit is 403
 *   `WRONG_AUDIENCE`. A controller with no audience is held to the staff rule (`AudienceGuard`
 *   then answers 500 `AUDIENCE_MISSING`).
 *
 * The Origin check, the disabled check, the 7 day cap and the forced password change (only the
 * handler marked `@WhoAmI()` while a temporary password stands) apply to every audience it serves. The person, and what they may use, are read from the database on
 * every request, so a disabled account or a hat change acts on the next call. On a `staff` or
 * `partner` route it reads the person's `Access` (hats, grants, partner account, spec 0008) once,
 * judges the audience from those same hats, and puts it on `request.access` for `PermissionGuard`,
 * which runs after `AudienceGuard`: one read, one snapshot, so the audience and the permissions
 * can never disagree. It never caches an answer and never takes an audience, a permission or an
 * account from the request.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly origin: string;

  /**
   * Takes the reflector for route metadata, the Better Auth instance, the env for the trusted
   * origin, and the loader of the person's `Access`, which the audience is judged from too.
   */
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(ENV) env: Env,
    @Inject(AccessLoader) private readonly accessLoader: Pick<AccessLoader, 'load'>,
  ) {
    this.origin = staffOrigin(env);
  }

  /**
   * Applies the audience rules above. Throws 401 or 403 with a stable code, and on success puts
   * the person on `request.staff` (staff routes) or `request.partner` (partner routes), and what
   * they may do on `request.access`.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<GuardedRequest>();
    const response = http.getResponse<Response>();
    const audience = audienceOf(context.getClass());

    // Never read the cookie here: not even a valid staff session may act on these (AC-29).
    if (audience === 'portal' || audience === 'hook') return true;

    // Beyond SameSite=Lax: a write from another site must never carry our cookie's authority.
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== this.origin) {
      throw new ForbiddenException({ code: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' });
    }

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getClass(),
    ]);
    // Class level only, on purpose: a handler can never open itself up inside a guarded controller.
    // The audience is the source of truth; `@Public()` stays honoured and a spec keeps them equal.
    if (isPublic || audience === 'public') return true;
    const needed: SessionAudience = audience === 'partner' ? 'partner' : 'staff';

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

    const { user, session } = found;
    // Read fresh on every request (AC-33 a), once: the audiences come from the same hats as the
    // permissions. A person with no hat left has no session at all (spec 0008, AC-10): every one
    // of theirs is deleted and the answer is an ended session.
    const access = await this.accessLoader.load(user.id);
    const allowed = audiencesOfHats(access.hats);
    if (allowed.size === 0) {
      const { internalAdapter } = await this.auth.$context;
      await internalAdapter.deleteUserSessions(user.id);
      throw this.unauthenticated(true);
    }

    // A used session renews its cookie (at most hourly); pass Better Auth's Set-Cookie on.
    for (const cookie of result.headers.getSetCookie()) response.append('set-cookie', cookie);

    // A live session of the other audience. The answer never says which audience would fit.
    if (!allowed.has(needed)) {
      throw new ForbiddenException({ code: 'WRONG_AUDIENCE', message: 'Not allowed here.' });
    }

    const shared = {
      name: user.name,
      email: user.email,
      phone: user.phone ?? null,
      language: user.language ?? null,
      twoFactorEnabled: user.twoFactorEnabled ?? false,
      mustChangePassword: user.mustChangePassword,
      home: homeOf(allowed),
      sessionId: session.id,
    };
    // Never from the session or the cookie: the read above, of this request.
    request.access = access;
    // A partner user gets the partner shape, with the account of their own hat row (spec 0008,
    // AC-9). Neither shape carries anything to authorize on: permissions live only on
    // `request.access`.
    if (needed === 'partner') {
      // The hat rules bind every partner hat to one account; a row without one fails closed.
      if (access.partnerAccountId === null) throw forbidden();
      request.partner = {
        userId: user.id,
        partnerAccountId: access.partnerAccountId,
        ...shared,
      } satisfies CurrentPartner;
    } else {
      request.staff = {
        id: user.id,
        staffCode: user.staffCode ?? null,
        ...shared,
      } satisfies CurrentStaff;
    }

    // A temporary password must be changed first (AC-14): only "who am I" works until then, the
    // handler marked `@WhoAmI()` (never matched by its path). Change password and sign out are
    // Better Auth routes, which their own before hook lets through.
    if (user.mustChangePassword && !isWhoAmI(context.getHandler())) {
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
