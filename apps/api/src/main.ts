import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { ENV } from './config/config.module.js';
import type { Env } from './config/env.js';
import { loadExtensions } from './extensions/load-extensions.js';

// Entry point: `api` (HTTP). The `migrate` entry point is src/migrate.ts.
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const env = app.get<Env>(ENV);

  // Caddy is the single proxy hop in front of the api; trust its X-Forwarded-* headers.
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  await loadExtensions(env.EXTENSIONS);
  await app.listen(env.PORT, '0.0.0.0');
}
await bootstrap();
