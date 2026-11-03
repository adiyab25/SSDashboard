import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import type { Auth } from './auth.tokens.js';

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
]);

/** Routes with a token in the path: one segment only, so nothing deeper slips through. */
const ALLOWED_PATTERNS: readonly RegExp[] = [/^GET \/reset-password\/[^/]+$/];

type Mountable = {
  all: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
};

/**
 * Mounts Better Auth at `/api/auth`. It runs before any body parser, so Better Auth reads the
 * raw request itself. Better Auth routes skip the NestJS guard, hence the allowlist here.
 */
export function mountAuth(app: NestExpressApplication, auth: Auth): void {
  const handle = toNodeHandler(auth);
  const server = app.getHttpAdapter().getInstance() as Mountable;

  server.all(`${BASE}/*splat`, (req, res, next) => {
    const path = new URL(req.originalUrl, 'http://localhost').pathname
      .slice(BASE.length)
      .replace(/\/+$/, '');
    const route = `${req.method} ${path}`;
    if (!ALLOWED_ROUTES.has(route) && !ALLOWED_PATTERNS.some((pattern) => pattern.test(route))) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Not found' });
      return;
    }
    Promise.resolve(handle(req, res)).catch(next);
  });
}
