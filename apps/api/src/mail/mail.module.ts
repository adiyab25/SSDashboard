import { Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { MailRecipientsModule } from '../identity/sign-in/mail-recipients.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MailProducer } from './mail-queue.js';
import { MailWorker } from './mail.worker.js';
import { MAILER } from './mail.tokens.js';
import { createMailer } from './mailer.js';

/** The api side of email (spec 0005): it only queues. Sending happens in the worker. */
@Module({ providers: [MailProducer], exports: [MailProducer] })
export class MailModule {}

/**
 * The worker side: the queue consumer and the mail adapter the install is set up for. The
 * recipient and token rows come from identity's `MailRecipients`, never from the auth tables.
 */
@Module({
  imports: [PlatformModule, MailRecipientsModule],
  providers: [
    { provide: MAILER, inject: [ENV], useFactory: (env: Env) => createMailer(env) },
    MailWorker,
  ],
})
export class MailWorkerModule {}
