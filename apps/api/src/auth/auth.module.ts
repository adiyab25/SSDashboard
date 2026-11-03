import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE } from '../database/database.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AuthAudit } from './auth-audit.service.js';
import { AuthMail } from './auth-mail.service.js';
import { createAuth } from './auth.factory.js';
import { AUTH, type Auth } from './auth.tokens.js';
import { MeController } from './me.controller.js';
import { SessionGuard } from './session.guard.js';
import { SignInLockout } from './sign-in-lockout.js';

/**
 * Staff sign in (spec 0005): Better Auth, the lockout, the mail callbacks, the global session
 * guard, and `GET /api/me`.
 */
@Global()
@Module({
  imports: [MailModule],
  controllers: [MeController],
  providers: [
    SignInLockout,
    AuthAudit,
    AuthMail,
    {
      provide: AUTH,
      inject: [ENV, DATABASE, SignInLockout, AuthAudit, AuthMail],
      useFactory: (
        env: Env,
        connection: DatabaseConnection,
        lockout: SignInLockout,
        audit: AuthAudit,
        mail: AuthMail,
      ): Auth => createAuth(env, connection.db, { lockout, audit, mail }),
    },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
