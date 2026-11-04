import type { NestExpressApplication } from '@nestjs/platform-express';
import { AUTH, type Auth } from './auth/auth.tokens.js';
import { mountAuth } from './auth/mount-auth.js';
import { QueryErrorFilter } from './platform/query-error.filter.js';

/**
 * HTTP wiring shared by every way the api starts. Create the app with `bodyParser: false`:
 * Better Auth must see the raw body, so it is mounted first and the parsers follow it.
 */
export function configureApp(app: NestExpressApplication): void {
  // Caddy is the single proxy hop in front of the api; trust its X-Forwarded-* headers.
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  // A failed query is logged with its pg code only, never with its params.
  app.useGlobalFilters(new QueryErrorFilter(app.getHttpAdapter()));
  mountAuth(app, app.get<Auth>(AUTH));
  app.useBodyParser('json');
  app.useBodyParser('urlencoded', { extended: true });
  app.enableShutdownHooks();
}
