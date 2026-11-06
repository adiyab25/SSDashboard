import { Inject, Injectable, Module } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';

/** Who a queued email goes to, read when it is sent. */
export interface MailRecipient {
  name: string;
  email: string;
  /** The person's saved language, or null to use the install's default. */
  language: string | null;
  /** True for a disabled account, which is never sent mail. */
  banned: boolean;
}

/** The reset or invite token row a queued email links to. */
export interface MailToken {
  /** Better Auth's identifier, `reset-password:<token>` for reset and invite tokens. */
  identifier: string;
  /** True once `expires_at` has passed. */
  expired: boolean;
}

interface RecipientRow extends MailRecipient, Record<string, unknown> {}

interface TokenRow extends MailToken, Record<string, unknown> {}

/**
 * Read only lookups the mail worker needs to send a queued email (spec 0005, AC-11): the
 * recipient and the token row, both read at send time so no link sits in the queue. It lets the
 * mail module work without reading the auth tables itself (spec 0002, A5). It never writes, and
 * never returns a password, hash or two factor secret. Never log what this returns: the token
 * row holds a live reset or invite token, and the recipient is personal data (Law 151).
 */
@Injectable()
export class MailRecipients {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** The person an email is for, or undefined when the account no longer exists. */
  async recipient(userId: string): Promise<MailRecipient | undefined> {
    const { rows } = await this.connection.db.execute<RecipientRow>(
      sql`SELECT name, email, language, banned FROM users WHERE id = ${userId}::uuid`,
    );
    const row = rows[0];
    return row && { name: row.name, email: row.email, language: row.language, banned: row.banned };
  }

  /**
   * The token row an email links to, or undefined once it was used, replaced or deleted. The
   * identifier holds the live token: never log what this returns.
   */
  async token(tokenId: string): Promise<MailToken | undefined> {
    const { rows } = await this.connection.db.execute<TokenRow>(
      sql`SELECT identifier, expires_at <= now() AS expired FROM verifications WHERE id = ${tokenId}::uuid`,
    );
    const row = rows[0];
    return row && { identifier: row.identifier, expired: row.expired };
  }
}

/**
 * Exports `MailRecipients` to the mail worker, which imports this module directly (it is on the
 * identity import wall's public list; `IdentityModule` does not re-export it). It holds no Better
 * Auth, guard or mail dependency, so the worker can load it without the HTTP side of identity.
 */
@Module({ providers: [MailRecipients], exports: [MailRecipients] })
export class MailRecipientsModule {}
