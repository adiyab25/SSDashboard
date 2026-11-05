import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE } from '../database/database.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AudienceGuard } from '../platform/audience/audience.guard.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AuthAudit } from './auth-audit.service.js';
import { AuthMail } from './auth-mail.service.js';
import { createAuth } from './auth.factory.js';
import { AUTH, type Auth } from './auth.tokens.js';
import { MeController } from './me.controller.js';
import { ProfileService } from './profile.service.js';
import { RolesGuard } from './roles.guard.js';
import { SessionGuard } from './session.guard.js';
import { SignInLockout } from './sign-in-lockout.js';

/**
 * Staff sign in (spec 0005): Better Auth, the lockout, the mail callbacks, the global session
 * guard, and `GET /api/me`.
 */
@Global()
@Module({
  imports: [MailModule, PlatformModule],
  controllers: [MeController],
  providers: [
    SignInLockout,
    AuthAudit,
    AuthMail,
    ProfileService,
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
    // Registered after the session guard, which puts the person on the request first.
    { provide: APP_GUARD, useClass: RolesGuard },
    // Last: it reads who the session guard identified, and denies any route without an audience.
    { provide: APP_GUARD, useClass: AudienceGuard },
  ],
  exports: [AUTH, SignInLockout, AuthAudit],
})
export class AuthModule {}
