import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import { TOKEN_IDENTIFIER_PREFIX } from '../../mail/mail-links.js';
import { MailProducer } from '../../mail/mail-queue.js';
import { PasswordResetCompleted } from '../../platform/events/auth-events.js';
import { AuthAudit } from './auth-audit.service.js';
import { clientIp, emailKey, userAgent } from './client-info.js';
import { SignInLockout } from './sign-in-lockout.js';

interface IdRow extends Record<string, unknown> {
  id: string;
}

/**
 * What Better Auth's password reset calls back into (spec 0005, AC-9, AC-11): queue the email,
 * and tidy up once a new password is set. Better Auth owns the token and the new hash.
 */
@Injectable()
export class AuthMail {
  private readonly db: Database;

  /** Takes the env, the app database connection, the mail producer, and the lockout and audit services. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) connection: DatabaseConnection,
    private readonly producer: MailProducer,
    private readonly lockout: SignInLockout,
    private readonly audit: AuthAudit,
  ) {
    this.db = connection.db;
  }

  /**
   * `sendResetPassword`: queue one email for a person who exists and is not disabled. Issuing a
   * new token deletes that person's older reset and invite tokens, so only the newest link works.
   * With no mail on this install, or a disabled account, nothing is queued.
   */
  async queueReset(user: { id: string; banned?: boolean | null }, token: string): Promise<void> {
    const identifier = `${TOKEN_IDENTIFIER_PREFIX}${token}`;
    if (this.env.MAIL_DRIVER === 'none' || user.banned) {
      // Better Auth already stored the token. Nobody will be sent it, so it must not stay live.
      await this.db.execute(sql`DELETE FROM verifications WHERE identifier = ${identifier}`);
      return;
    }
    const prefix = `${TOKEN_IDENTIFIER_PREFIX}%`;
    const result = await this.db.execute<IdRow>(sql`
      WITH older AS (
        DELETE FROM verifications
         WHERE identifier LIKE ${prefix} AND value = ${user.id} AND identifier <> ${identifier}
      )
      SELECT id FROM verifications WHERE identifier = ${identifier}`);
    const tokenId = result.rows[0]?.id;
    if (tokenId === undefined) return;
    await this.producer.enqueue({ userId: user.id, kind: 'reset', tokenId });
  }

  /**
   * `onPasswordReset`: the person proved they hold the link, so their email counts as verified,
   * a temporary password no longer needs changing, and a lockout no longer applies. Better Auth
   * has already revoked their sessions.
   */
  async completeReset(user: { id: string; email: string }, request: Request | undefined) {
    await this.db.execute(
      sql`UPDATE users SET email_verified = true, must_change_password = false, updated_at = now()
           WHERE id = ${user.id}::uuid`,
    );
    await this.lockout.reset(emailKey(user.email));
    this.audit.record(
      new PasswordResetCompleted({
        actorId: user.id,
        targetId: user.id,
        ip: clientIp(request?.headers),
        userAgent: userAgent(request?.headers),
        at: new Date(),
      }),
    );
  }
}
