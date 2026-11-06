import { Logger } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Env } from '../config/env.js';
import type {
  MailRecipient,
  MailRecipients,
  MailToken,
} from '../identity/sign-in/mail-recipients.js';
import type { SettingsService } from '../platform/settings.service.js';
import { MAIL_RETRY_LIMIT, type MailJob } from './mail-queue.js';
import { MailWorker } from './mail.worker.js';
import type { Mailer } from './mailer.js';

const env = {
  PUBLIC_URL: 'https://erp.example.com',
  STAFF_BASE_PATH: '',
  CLIENT_DISPLAY_NAME: 'Acme Home',
} as Env;

const JOB: MailJob = { userId: 'user-1', kind: 'reset', tokenId: 'token-1' };

function setup(options: {
  person?: MailRecipient | null;
  token?: MailToken | null;
  installLanguage?: string;
  mailer?: Mailer | null;
  basePath?: string;
}) {
  const person =
    options.person === undefined
      ? { name: 'Sam', email: 'sam@example.com', language: null, banned: false }
      : options.person;
  const token =
    options.token === undefined
      ? { identifier: 'reset-password:secrettoken', expired: false }
      : options.token;
  const recipients = {
    recipient: vi.fn(() => Promise.resolve(person ?? undefined)),
    token: vi.fn(() => Promise.resolve(token ?? undefined)),
  } as unknown as MailRecipients;
  const send = vi.fn<Mailer['send']>(() => Promise.resolve());
  const mailer = options.mailer === undefined ? { send } : options.mailer;
  const read = vi.fn(() => Promise.resolve({ default_language: options.installLanguage ?? 'en' }));
  const settings = { read } as unknown as SettingsService;
  const worker = new MailWorker(
    { ...env, STAFF_BASE_PATH: options.basePath ?? '' },
    recipients,
    mailer,
    settings,
  );
  const job = (retryCount = 0) => ({ id: 'job-1', data: JOB, retryCount }) as Job<MailJob>;
  return { worker, send, job, read };
}

describe('MailWorker', () => {
  let log: MockInstance;
  let warn: MockInstance;
  let error: MockInstance;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads the token when it sends and mails the link to the person', async () => {
    const { worker, send, job } = setup({});

    await worker.handle(job());

    const mail = send.mock.calls[0]?.[0];
    expect(mail?.to).toBe('sam@example.com');
    expect(mail?.subject).toBe('Reset your Acme Home password');
    expect(mail?.text).toContain('https://erp.example.com/api/auth/reset-password/secrettoken?');
  });

  it('puts STAFF_BASE_PATH between the staff origin and the route (AC-31)', async () => {
    const { worker, send, job } = setup({ basePath: '/ops' });

    await worker.handle(job());

    const text = send.mock.calls[0]?.[0].text ?? '';
    expect(text).toContain('https://erp.example.com/ops/api/auth/reset-password/secrettoken?');
    expect(text).toContain(
      `callbackURL=${encodeURIComponent('https://erp.example.com/ops/reset-password')}`,
    );
  });

  it("writes the email in the person's saved language, else the install's default", async () => {
    const saved = setup({
      person: { name: 'سام', email: 'sam@example.com', language: 'ar', banned: false },
      installLanguage: 'en',
    });
    await saved.worker.handle(saved.job());
    expect(saved.send.mock.calls[0]?.[0].html).toContain('dir="rtl"');
    expect(saved.read).not.toHaveBeenCalled();

    const fallback = setup({ installLanguage: 'ar' });
    await fallback.worker.handle(fallback.job());
    expect(fallback.send.mock.calls[0]?.[0].html).toContain('dir="rtl"');
  });

  it('falls back to English when the default language cannot be read', async () => {
    const { worker, send, job, read } = setup({});
    read.mockRejectedValueOnce(new Error('down'));

    await worker.handle(job());

    expect(send.mock.calls[0]?.[0].html).toContain('dir="ltr"');
  });

  it.each([
    ['the token is gone', { token: null }],
    ['the token has expired', { token: { identifier: 'reset-password:t', expired: true } }],
    ['the row is not a reset token', { token: { identifier: 'other:t', expired: false } }],
    [
      'the person is disabled',
      { person: { name: 'S', email: 'e@x.com', language: null, banned: true } },
    ],
    ['the person is gone', { person: null }],
  ])('sends nothing and does not retry when %s', async (_name, options) => {
    const { worker, send, job } = setup(options);

    await expect(worker.handle(job())).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('does nothing when the install has no mail', async () => {
    const { worker, job } = setup({ mailer: null });

    await expect(worker.handle(job())).resolves.toBeUndefined();
  });

  it('rethrows a send failure so the job retries, and warns without the link', async () => {
    const { worker, send, job } = setup({});
    send.mockRejectedValueOnce(new Error('connection refused'));

    await expect(worker.handle(job(1))).rejects.toThrow('connection refused');

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('job-1');
    expect(error).not.toHaveBeenCalled();
  });

  it('logs the last failure by job id, never the link, and still rethrows', async () => {
    const { worker, send, job } = setup({});
    send.mockRejectedValueOnce(new Error('mailbox full'));

    await expect(worker.handle(job(MAIL_RETRY_LIMIT))).rejects.toThrow('mailbox full');

    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain('Mail job job-1 failed for good');
    expect(line).not.toContain('secrettoken');
    expect(line).not.toContain('reset-password');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('secrettoken'));
  });
});
