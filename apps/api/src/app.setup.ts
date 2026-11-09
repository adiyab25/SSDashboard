import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ENV } from './config/config.module.js';
import type { Env } from './config/env.js';
import { mountHooks } from './connectors/hooks/mount-hooks.js';
import { AUTH, type Auth } from './identity/sign-in/auth.tokens.js';
import { mountAuth } from './identity/sign-in/mount-auth.js';
import { QueryErrorFilter } from './platform/query-error.filter.js';

/**
 * How long the api keeps an idle keep-alive connection open, in milliseconds: longer than any
 * client in front of it keeps one idle, so the client always closes first.
 *
 * Why: Node's default (5 s, closed at about 6 s with its built in buffer) races a client that
 * reuses an idle connection at that moment: the request lands on a closing socket and fails with
 * `ECONNRESET`. Caddy keeps idle upstream connections for 2 minutes (its default), where a POST
 * would answer 502; the `next dev` rewrite proxy (httpxy) never expires them, which failed e2e
 * runs (2026-11-08). Never lower it below Caddy's idle time.
 */
export const IDLE_CONNECTION_TIMEOUT_MS = 130_000;

/**
 * HTTP wiring shared by every way the api starts. Create the app with `bodyParser: false`:
 * Better Auth must see the raw body, so it is mounted first; the connector hooks' raw body reader
 * and signature check (`/api/hooks/*`, at most 2 MB, spec 0015 AC-4) come next, and only then the
 * JSON and form parsers, which skip a body the hook reader already consumed.
 */
export function configureApp(app: NestExpressApplication): void {
  // Caddy is the single proxy hop in front of the api; trust its X-Forwarded-* headers.
  app.set('trust proxy', 1);
  const server: Server = app.getHttpServer();
  server.keepAliveTimeout = IDLE_CONNECTION_TIMEOUT_MS;
  app.setGlobalPrefix('api');
  // A failed query is logged with its pg code only, never with its params.
  app.useGlobalFilters(new QueryErrorFilter(app.getHttpAdapter()));
  mountAuth(app, app.get<Auth>(AUTH), app.get<Env>(ENV));
  mountHooks(app);
  app.useBodyParser('json');
  app.useBodyParser('urlencoded', { extended: true });
  app.enableShutdownHooks();
}
