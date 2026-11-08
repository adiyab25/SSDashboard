import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { ENV } from '../config/config.module.js';
import { staffBase, type Env } from '../config/env.js';
import { MailRecipients } from '../identity/sign-in/mail-recipients.js';
import { JobRegistry } from '../platform/jobs/job-registry.js';
import { SettingsService } from '../platform/settings/settings.service.js';
import { tokenFromIdentifier, tokenLink } from './mail-links.js';
import { MAIL_JOB, MAIL_RETRY_LIMIT, type MailJob } from './mail-queue.js';
import { renderMail } from './mail-templates.js';
import { MAILER } from './mail.tokens.js';
import type { Mailer } from './mailer.js';

/**
 * Sends the queued emails in the `worker` entry point (spec 0005, AC-11). Its queue and handler
 * are declared through the platform `JobRegistry` (spec 0009, AC-10), so the worker's one pg-boss
 * client works it behind the module gate. On an install without a mailer nothing is ever queued,
 * and a job that still arrives is completed unsent.
 */
@Injectable()
export class MailWorker implements OnModuleInit {
  private readonly logger = new Logger('Mail');

  /**
   * Takes the env, identity's mail recipient reader (the recipient and token rows belong to
   * identity), the mailer (null when `MAIL_DRIVER` is none), the settings service, and the job
   * registry (absent in unit tests that call `handle` directly).
   */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(MailRecipients) private readonly recipients: MailRecipients,
    @Inject(MAILER) private readonly mailer: Mailer | null,
    private readonly settings: SettingsService,
    @Inject(JobRegistry) private readonly jobs?: JobRegistry,
  ) {}

  /** Declares the mail queue and its send handler. */
  onModuleInit(): void {
    this.jobs?.declareQueue(MAIL_JOB);
    this.jobs?.declareHandler({
      queue: MAIL_JOB.name,
      capability: MAIL_JOB.capability,
      handle: async (job) => {
        await this.handle(job as Job<MailJob>);
        return undefined;
      },
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

    const person = await this.recipients.recipient(userId);
    const row = await this.recipients.token(tokenId);
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
      link: tokenLink(staffBase(this.env), token, kind),
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
}
