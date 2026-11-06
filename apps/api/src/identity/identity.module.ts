import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE } from '../database/database.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AudienceGuard } from '../platform/audience/audience.guard.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AuthAudit } from './sign-in/auth-audit.service.js';
import { AuthMail } from './sign-in/auth-mail.service.js';
import { createAuth } from './sign-in/auth.factory.js';
import { AUTH, type Auth } from './sign-in/auth.tokens.js';
import { MailRecipientsModule } from './sign-in/mail-recipients.js';
import { MeController } from './sign-in/me.controller.js';
import { ProfileService } from './sign-in/profile.service.js';
import { RolesGuard } from './sign-in/roles.guard.js';
import { SessionGuard } from './sign-in/session.guard.js';
import { SignInLockout } from './sign-in/sign-in-lockout.js';
import { StaffDirectoryModule } from './staff/staff-directory.js';
import { StaffController } from './staff/staff.controller.js';
import { StaffService } from './staff/staff.service.js';

/**
 * The identity module (spec 0005, AC-27): staff sign in (Better Auth, the lockout, the mail
 * callbacks, the global session guard, `GET /api/me`) and staff administration (`/api/staff`).
 *
 * Other modules reach identity only through what it exports: `StaffDirectory` (names for
 * "posted by"), `MailRecipients` (who a queued email goes to, and its token row), and the
 * current user reader in `sign-in/current-staff.ts`, a request type with no provider. It must
 * never export the Better Auth instance, the lockout, or the audit service: the auth tables are
 * written only from inside this module.
 */
@Module({
  imports: [MailModule, PlatformModule, StaffDirectoryModule, MailRecipientsModule],
  controllers: [MeController, StaffController],
  providers: [
    SignInLockout,
    AuthAudit,
    AuthMail,
    ProfileService,
    StaffService,
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
  exports: [StaffDirectoryModule, MailRecipientsModule],
})
export class IdentityModule {}
