import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import { MailRecipients } from './mail-recipients.js';

function setup(rows: Record<string, unknown>[]) {
  const execute = vi.fn(() => Promise.resolve({ rows }));
  const reader = new MailRecipients({ db: { execute } } as unknown as DatabaseConnection);
  return { reader, execute };
}

// Spec 0005, AC-11 and AC-27: the mail worker reads the recipient and token through identity.
describe('MailRecipients', () => {
  it('returns only the fields an email needs', async () => {
    const { reader } = setup([
      { name: 'Sam', email: 'sam@example.com', language: 'ar', banned: false, extra: 'x' },
    ]);

    await expect(reader.recipient('user-1')).resolves.toEqual({
      name: 'Sam',
      email: 'sam@example.com',
      language: 'ar',
      banned: false,
    });
  });

  it('returns the token identifier and whether it has expired', async () => {
    const { reader } = setup([{ identifier: 'reset-password:abc', expired: true }]);

    await expect(reader.token('token-1')).resolves.toEqual({
      identifier: 'reset-password:abc',
      expired: true,
    });
  });

  it('returns undefined for a person or token that is gone', async () => {
    const { reader } = setup([]);

    await expect(reader.recipient('user-1')).resolves.toBeUndefined();
    await expect(reader.token('token-1')).resolves.toBeUndefined();
  });
});
