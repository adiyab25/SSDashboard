import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import type { MailProducer } from '../../mail/mail-queue.js';
import { PasswordResetCompleted } from '../../platform/events/auth-events.js';
import type { AuthAudit } from './auth-audit.service.js';
import { AuthMail } from './auth-mail.service.js';
import type { SignInLockout } from './sign-in-lockout.js';

const USER = { id: '0190c0de-0000-7000-8000-000000000001', email: 'Sam@Example.com' };

function setup(driver: Env['MAIL_DRIVER'], rows: Array<{ id: string }> = [{ id: 'token-row' }]) {
  const execute = vi.fn(() => Promise.resolve({ rows }));
  const enqueue = vi.fn(() => Promise.resolve(true));
  const reset = vi.fn(() => Promise.resolve());
  const record = vi.fn();
  const mail = new AuthMail(
    { MAIL_DRIVER: driver } as Env,
    { db: { execute } } as unknown as DatabaseConnection,
    { enqueue } as unknown as MailProducer,
    { reset } as unknown as SignInLockout,
    { record } as unknown as AuthAudit,
  );
  return { mail, execute, enqueue, reset, record };
}

describe('AuthMail.queueReset (AC-9, AC-10, AC-11)', () => {
  it('queues one reset job holding only ids, after clearing older tokens', async () => {
    const { mail, execute, enqueue } = setup('smtp');

    await mail.queueReset({ id: USER.id, banned: false }, 'newtoken');

    expect(execute).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({ userId: USER.id, kind: 'reset', tokenId: 'token-row' });
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain('newtoken');
  });

  it('queues nothing, and drops the token Better Auth just stored, with no mail on the install', async () => {
    const { mail, execute, enqueue } = setup('none');

    await mail.queueReset({ id: USER.id, banned: false }, 'newtoken');

    expect(enqueue).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('queues nothing for a disabled person, and drops their token', async () => {
    const { mail, execute, enqueue } = setup('postmark');

    await mail.queueReset({ id: USER.id, banned: true }, 'newtoken');

    expect(enqueue).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('queues nothing when the new token row cannot be found', async () => {
    const { mail, enqueue } = setup('smtp', []);

    await mail.queueReset({ id: USER.id }, 'newtoken');

    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('AuthMail.completeReset (AC-9)', () => {
  it('verifies the email, clears the forced change, clears the lockout and emits the event', async () => {
    const { mail, execute, reset, record } = setup('smtp');
    const request = new Request('https://erp.example.com/api/auth/reset-password', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'TestAgent/1' },
    });

    await mail.completeReset(USER, request);

    expect(execute).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledWith('sam@example.com');
    const event = record.mock.calls[0]?.[0] as PasswordResetCompleted;
    expect(event).toBeInstanceOf(PasswordResetCompleted);
    expect(event.context).toMatchObject({
      actorId: USER.id,
      targetId: USER.id,
      ip: '203.0.113.9',
      userAgent: 'TestAgent/1',
    });
  });
});
