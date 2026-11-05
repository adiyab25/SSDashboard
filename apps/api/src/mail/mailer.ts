import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';

/** One message ready to hand to a mail service. */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** What the worker needs from a mail service: send one message, or throw so the job retries. */
export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/** Sends through any SMTP server (spec 0005): works on premises with no outside service. */
export class SmtpMailer implements Mailer {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  /**
   * Takes the sender address and the SMTP host, port, security mode and credentials from the
   * env.
   */
  constructor(
    private readonly from: string,
    options: Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURITY' | 'SMTP_USER' | 'SMTP_PASSWORD'>,
  ) {
    this.transport = nodemailer.createTransport({
      host: options.SMTP_HOST,
      port: options.SMTP_PORT,
      secure: options.SMTP_SECURITY === 'tls',
      requireTLS: options.SMTP_SECURITY === 'starttls',
      ignoreTLS: options.SMTP_SECURITY === 'none',
      ...(options.SMTP_USER !== undefined && {
        auth: { user: options.SMTP_USER, pass: options.SMTP_PASSWORD ?? '' },
      }),
      // A mail server that does not answer must fail the job, not hold the worker.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  /**
   * Sends through the SMTP transport. Throws on failure so the queue retries; connection
   * timeouts stop a silent server holding the worker.
   */
  async send(mail: OutgoingMail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

const POSTMARK_URL = 'https://api.postmarkapp.com/email';

/** Sends through Postmark's HTTP API. The sender must be verified there first. */
export class PostmarkMailer implements Mailer {
  /**
   * Takes the verified sender address, the Postmark server token, and a fetch function that
   * tests replace.
   */
  constructor(
    private readonly from: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Posts the message to Postmark. Throws on a failed answer so the queue retries. */
  async send(mail: OutgoingMail): Promise<void> {
    const response = await this.fetcher(POSTMARK_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-postmark-server-token': this.token,
      },
      body: JSON.stringify({
        From: this.from,
        To: mail.to,
        Subject: mail.subject,
        TextBody: mail.text,
        HtmlBody: mail.html,
        MessageStream: 'outbound',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      // Postmark's error carries a numeric code and a message about the request, never our content.
      const detail = (await response.json().catch(() => ({}))) as {
        ErrorCode?: number;
        Message?: string;
      };
      throw new Error(
        `Postmark answered ${response.status} (code ${detail.ErrorCode ?? 'unknown'}): ${detail.Message ?? 'no message'}`,
      );
    }
  }
}

/** The mailer the install is set up for, or null when `MAIL_DRIVER` is `none`. */
export function createMailer(env: Env): Mailer | null {
  switch (env.MAIL_DRIVER) {
    case 'none':
      return null;
    case 'smtp':
      return new SmtpMailer(env.MAIL_FROM as string, env);
    case 'postmark':
      return new PostmarkMailer(env.MAIL_FROM as string, env.POSTMARK_SERVER_TOKEN as string);
    default: {
      const unreachable: never = env.MAIL_DRIVER;
      new Logger('Mail').error(`Unknown MAIL_DRIVER ${String(unreachable)}`);
      return null;
    }
  }
}
