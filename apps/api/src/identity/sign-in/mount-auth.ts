import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../../config/env.js';
import { logAuthRequestFailure } from './auth-logger.js';
import type { Auth } from './auth.tokens.js';
import { isPortalRequest, portalHosts } from './portal-host.js';

const BASE = '/api/auth';

/**
 * Every Better Auth route the web app uses, as `METHOD /path`. Anything else answers 404: an
 * allowlist, so a route a plugin adds later is closed until a slice opens it on purpose.
 */
const ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  'POST /sign-in/email',
  'POST /sign-out',
  'POST /request-password-reset',
  'POST /reset-password',
  'POST /change-password',
  'POST /two-factor/enable',
  'POST /two-factor/verify-totp',
  'POST /two-factor/verify-backup-code',
  'POST /two-factor/generate-backup-codes',
  'POST /two-factor/disable',
]);

/** Routes with a token in the path: one segment only, so nothing deeper slips through. */
const ALLOWED_PATTERNS: readonly RegExp[] = [/^GET \/reset-password\/[^/]+$/];

type Mountable = {
  all: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
};

/**
 * Mounts Better Auth at `/api/auth`. It runs before any body parser, so Better Auth reads the
 * raw request itself. Better Auth routes skip the NestJS guard, hence the allowlist here. When
 * `PORTAL_ORIGIN` is set, a request that carries the portal host answers 404 on every auth
 * route (spec 0005, AC-30): sign in exists on the staff host only.
 */
export function mountAuth(
  app: NestExpressApplication,
  auth: Auth,
  env: Pick<Env, 'PORTAL_ORIGIN'>,
): void {
  const handle = toNodeHandler(auth);
  const server = app.getHttpAdapter().getInstance() as Mountable;
  const portal = portalHosts(env.PORTAL_ORIGIN);

  server.all(`${BASE}/*splat`, (req, res) => {
    if (isPortalRequest(req.headers, portal)) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Not found' });
      return;
    }
    const path = new URL(req.originalUrl, 'http://localhost').pathname
      .slice(BASE.length)
      .replace(/\/+$/, '');
    const route = `${req.method} ${path}`;
    if (!ALLOWED_ROUTES.has(route) && !ALLOWED_PATTERNS.some((pattern) => pattern.test(route))) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Not found' });
      return;
    }
    // Never `next(error)`: Express would print the raw error, query params included.
    Promise.resolve(handle(req, res)).catch((error: unknown) => {
      // A token in the path is a credential: the log names the route, not the token.
      logAuthRequestFailure(
        ALLOWED_ROUTES.has(route) ? route : route.replace(/[^/]+$/, ':token'),
        error,
      );
      if (res.headersSent) res.end();
      else res.status(500).end();
    });
  });
}
