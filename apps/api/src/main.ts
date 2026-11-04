import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ENV } from './config/config.module.js';
import type { Env } from './config/env.js';
import { loadExtensions } from './extensions/load-extensions.js';

// Entry point: `api` (HTTP). The `migrate` entry point is src/migrate.ts.
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const env = app.get<Env>(ENV);

  configureApp(app);

  await loadExtensions(env.EXTENSIONS);
  await app.listen(env.PORT, '0.0.0.0');
}
await bootstrap();
