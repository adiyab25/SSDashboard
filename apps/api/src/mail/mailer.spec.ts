import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import { createMailer, PostmarkMailer, SmtpMailer } from './mailer.js';

const MAIL = { to: 'sam@example.com', subject: 'Hello', text: 'plain', html: '<p>html</p>' };

describe('PostmarkMailer', () => {
  it('posts the message to Postmark with the server token', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));

    await new PostmarkMailer('ERP <no-reply@client.com>', 'secret-token', fetcher).send(MAIL);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['x-postmark-server-token']).toBe(
      'secret-token',
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      From: 'ERP <no-reply@client.com>',
      To: 'sam@example.com',
      Subject: 'Hello',
      TextBody: 'plain',
      HtmlBody: '<p>html</p>',
      MessageStream: 'outbound',
    });
  });

  it('throws with Postmark code and message when it refuses, and never repeats the mail', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ErrorCode: 400, Message: 'Sender signature not found' }), {
          status: 422,
        }),
      ),
    );

    const failure = await new PostmarkMailer('x@y.com', 't', fetcher)
      .send(MAIL)
      .catch((e: Error) => e);

    expect((failure as Error).message).toBe(
      'Postmark answered 422 (code 400): Sender signature not found',
    );
    expect((failure as Error).message).not.toContain('html');
  });

  it('still throws when the error body is not JSON', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('oops', { status: 502 })),
    );

    await expect(new PostmarkMailer('x@y.com', 't', fetcher).send(MAIL)).rejects.toThrow(
      'Postmark answered 502 (code unknown)',
    );
  });
});

describe('createMailer', () => {
  const env = (overrides: Partial<Env>) =>
    ({
      MAIL_DRIVER: 'none',
      MAIL_FROM: 'no-reply@client.com',
      SMTP_HOST: 'mail.client.com',
      SMTP_PORT: 587,
      SMTP_SECURITY: 'starttls',
      POSTMARK_SERVER_TOKEN: 'token',
      ...overrides,
    }) as Env;

  it('makes no mailer when the driver is none, so nothing can send', () => {
    expect(createMailer(env({ MAIL_DRIVER: 'none' }))).toBeNull();
  });

  it('makes the adapter the driver names', () => {
    expect(createMailer(env({ MAIL_DRIVER: 'smtp' }))).toBeInstanceOf(SmtpMailer);
    expect(createMailer(env({ MAIL_DRIVER: 'postmark' }))).toBeInstanceOf(PostmarkMailer);
  });
});
