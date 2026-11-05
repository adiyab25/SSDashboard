import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { PgBoss, type Job } from 'pg-boss';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE } from '../database/database.module.js';
import { JOB_SCHEMA } from '../inventory/ledger/reconcile.job.js';
import { SettingsService } from '../platform/settings.service.js';
import { tokenFromIdentifier, tokenLink } from './mail-links.js';
import { MAIL_QUEUE, MAIL_RETRY_LIMIT, ensureMailQueue, type MailJob } from './mail-queue.js';
import { renderMail } from './mail-templates.js';
import { MAILER } from './mail.tokens.js';
import type { Mailer } from './mailer.js';

interface RecipientRow extends Record<string, unknown> {
  name: string;
  email: string;
  language: string | null;
  banned: boolean;
}

interface TokenRow extends Record<string, unknown> {
  identifier: string;
  expired: boolean;
}

/** Sends the queued emails in the `worker` entry point (spec 0005, AC-11). */
@Injectable()
export class MailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Mail');
  private readonly db: Database;
  private boss: PgBoss | undefined;

  /**
   * Takes the env, the app database connection, the mailer (null when `MAIL_DRIVER` is none) and
   * the settings service.
   */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(MAILER) private readonly mailer: Mailer | null,
    private readonly settings: SettingsService,
  ) {
    this.db = connection.db;
  }

  /**
   * Starts the queue and the send handler. Does nothing on an install without a mailer, because
   * nothing is ever queued there.
   */
  async onApplicationBootstrap(): Promise<void> {
    // No mail on this install: nothing is queued, so there is nothing to work.
    if (!this.mailer) return;
    const boss = new PgBoss({
      connectionString: this.env.DATABASE_URL,
      schema: JOB_SCHEMA,
      createSchema: false,
      // It sends one email at a time; the default pool of 10 would be wasted connections.
      max: 4,
    });
    boss.on('error', (error: Error) => this.logger.error(`Job queue error: ${error.message}`));
    await boss.start();
    this.boss = boss;
    await ensureMailQueue(boss);
    await boss.work<MailJob>(MAIL_QUEUE, async (jobs) => {
      for (const job of jobs) await this.handle(job);
    });
  }

  /** Throws when the send fails, so pg-boss retries; the last failure is logged by job id. */
  async handle(job: Job<MailJob>): Promise<void> {
    try {
      await this.send(job.data);
    } catch (error) {
      // Never the link: only the job id and what the mail service said.
      const detail = error instanceof Error ? error.message : String(error);
      if (job.retryCount >= MAIL_RETRY_LIMIT) {
        this.logger.error(
          `Mail job ${job.id} failed for good after ${job.retryCount + 1} tries: ${detail}`,
        );
      } else {
        this.logger.warn(
          `Mail job ${job.id} failed (try ${job.retryCount + 1}), will retry: ${detail}`,
        );
      }
      throw error;
    }
  }

  private async send({ userId, kind, tokenId }: MailJob): Promise<void> {
    const mailer = this.mailer;
    if (!mailer) return;

    const people = await this.db.execute<RecipientRow>(
      sql`SELECT name, email, language, banned FROM users WHERE id = ${userId}::uuid`,
    );
    const person = people.rows[0];
    const tokens = await this.db.execute<TokenRow>(
      sql`SELECT identifier, expires_at <= now() AS expired FROM verifications WHERE id = ${tokenId}::uuid`,
    );
    const row = tokens.rows[0];
    const token = row ? tokenFromIdentifier(row.identifier) : undefined;

    // The token was used, replaced by a newer one, deleted with a disable, or has expired since
    // the job was queued: there is nothing valid to send, and retrying would not change that.
    if (!person || person.banned || !row || row.expired || token === undefined) {
      this.logger.log(`Mail job for ${userId} skipped: the ${kind} token is no longer valid`);
      return;
    }

    const language = person.language ?? (await this.defaultLanguage());
    const mail = renderMail({
      kind,
      language,
      name: person.name,
      clientName: this.env.CLIENT_DISPLAY_NAME,
      link: tokenLink(this.env.PUBLIC_URL, token, kind),
    });
    await mailer.send({ to: person.email, ...mail });
    this.logger.log(`Sent a ${kind} email for ${userId}`);
  }

  /** The install's default language (spec 0004), else English. */
  private async defaultLanguage(): Promise<string> {
    try {
      const { default_language } = await this.settings.read(['default_language']);
      return default_language ?? 'en';
    } catch {
      return 'en';
    }
  }

  /** Stops the queue after letting a send in progress finish. */
  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
