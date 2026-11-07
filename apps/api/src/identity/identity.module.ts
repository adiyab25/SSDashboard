import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE } from '../database/database.module.js';
import { MailModule } from '../mail/mail.module.js';
import { PermissionGuard } from '../platform/access/permission.guard.js';
import { AudienceGuard } from '../platform/audience/audience.guard.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AccessLoader } from './access/access-loader.js';
import { IDENTITY_AUDIT, PendingIdentityAudit } from './audit-port/identity-audit.js';
import { HatService } from './hats/hat.service.js';
import { AuthAudit } from './sign-in/auth-audit.service.js';
import { AuthMail } from './sign-in/auth-mail.service.js';
import { createAuth } from './sign-in/auth.factory.js';
import { AUTH, type Auth } from './sign-in/auth.tokens.js';
import { HatSessionAudiences, SESSION_AUDIENCES } from './sessions/session-audiences.js';
import { MeController } from './sign-in/me.controller.js';
import { ProfileService } from './sign-in/profile.service.js';
import { SessionGuard } from './sign-in/session.guard.js';
import { SignInLockout } from './sign-in/sign-in-lockout.js';
import { StaffController } from './staff/staff.controller.js';
import { StaffService } from './staff/staff.service.js';

/**
 * The identity module (spec 0005, AC-27): staff sign in (Better Auth, the lockout, the mail
 * callbacks, the global session guard, `GET /api/me`), the person's hats and grants read on every
 * request (spec 0008, `access/`), giving and taking hats (`hats/`, `HatService`), and staff
 * administration (`/api/staff`).
 *
 * It exports no provider. Other modules reach identity only through a short list of files,
 * `IDENTITY_PUBLIC_FILES` in `src/module-boundary.spec.ts`: this file, the request type in
 * `sign-in/current-staff.ts`, the `@Public()` decorator, and the small
 * `StaffDirectoryModule` and `MailRecipientsModule`, which a consumer imports directly. That
 * import wall is the enforcement, not Nest's `exports`. It must never expose the Better Auth
 * instance, the lockout, or the audit service: the auth tables are written only from inside
 * this module.
 */
@Module({
  imports: [MailModule, PlatformModule],
  controllers: [MeController, StaffController],
  providers: [
    SignInLockout,
    AuthAudit,
    AuthMail,
    ProfileService,
    StaffService,
    AccessLoader,
    HatService,
    // The audit trail of spec 0010 is not on this branch yet: entries go nowhere and the log lines
    // and events stay the record. When `AuditService` lands, bind an adapter over it here.
    { provide: IDENTITY_AUDIT, useClass: PendingIdentityAudit },
    // Who may use which audience, from the person's hats (spec 0008, AC-10).
    { provide: SESSION_AUDIENCES, useClass: HatSessionAudiences },
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
    // The guards run in this order (spec 0008, guard order): the session guard puts the person
    // and their `Access` on the request, the audience guard denies any route without an audience
    // or of another audience, and the permission guard checks the route's declaration last.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: AudienceGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class IdentityModule {}
