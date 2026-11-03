import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE } from '../database/database.module.js';
import { AuthAudit } from './auth-audit.service.js';
import { createAuth } from './auth.factory.js';
import { AUTH, type Auth } from './auth.tokens.js';
import { MeController } from './me.controller.js';
import { SessionGuard } from './session.guard.js';
import { SignInLockout } from './sign-in-lockout.js';

/** Staff sign in (spec 0005): Better Auth, the lockout, the global session guard, and `GET /api/me`. */
@Global()
@Module({
  controllers: [MeController],
  providers: [
    SignInLockout,
    AuthAudit,
    {
      provide: AUTH,
      inject: [ENV, DATABASE, SignInLockout, AuthAudit],
      useFactory: (
        env: Env,
        connection: DatabaseConnection,
        lockout: SignInLockout,
        audit: AuthAudit,
      ): Auth => createAuth(env, connection.db, { lockout, audit }),
    },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
