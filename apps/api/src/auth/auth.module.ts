import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE } from '../database/database.module.js';
import { createAuth } from './auth.factory.js';
import { AUTH, type Auth } from './auth.tokens.js';
import { MeController } from './me.controller.js';
import { SessionGuard } from './session.guard.js';

/** Staff sign in (spec 0005): Better Auth, the global session guard, and `GET /api/me`. */
@Global()
@Module({
  controllers: [MeController],
  providers: [
    {
      provide: AUTH,
      inject: [ENV, DATABASE],
      useFactory: (env: Env, connection: DatabaseConnection): Auth =>
        createAuth(env, connection.db),
    },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
