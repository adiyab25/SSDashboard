import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../../database/sql.js';
import { hatChangeEndsSessions, revokeSessions, type HatStanding } from './revoke-sessions.js';
import type { SessionAudience } from './session-audiences.js';

const standing = (
  audiences: SessionAudience[],
  partnerAccountId: string | null = null,
): HatStanding => ({ audiences: new Set(audiences), partnerAccountId });

describe('hatChangeEndsSessions (spec 0005, AC-33 b)', () => {
  it('ends the sessions of a change that leaves no hat at all', () => {
    expect(hatChangeEndsSessions(standing(['staff']), standing([]))).toBe(true);
    expect(hatChangeEndsSessions(standing(['partner'], 'p1'), standing([], null))).toBe(true);
  });

  it('ends the sessions of a move between the staff and partner audiences', () => {
    expect(hatChangeEndsSessions(standing(['staff']), standing(['partner'], 'p1'))).toBe(true);
    expect(hatChangeEndsSessions(standing(['partner'], 'p1'), standing(['staff']))).toBe(true);
    expect(hatChangeEndsSessions(standing(['staff']), standing(['staff', 'partner']))).toBe(true);
  });

  it('ends the sessions of a move to another partner account', () => {
    expect(hatChangeEndsSessions(standing(['partner'], 'p1'), standing(['partner'], 'p2'))).toBe(
      true,
    );
  });

  it('keeps the sessions when the person keeps a hat of the same audience and account', () => {
    expect(hatChangeEndsSessions(standing(['staff']), standing(['staff']))).toBe(false);
    expect(hatChangeEndsSessions(standing(['partner'], 'p1'), standing(['partner'], 'p1'))).toBe(
      false,
    );
  });
});

describe('revokeSessions (AC-33 c)', () => {
  it('deletes the person’s sessions through the caller’s transaction, and counts them', async () => {
    const execute = vi.fn(() => Promise.resolve({ rowCount: 2, rows: [] }));
    const tx = { execute } as unknown as Transaction;

    await expect(revokeSessions('0190c0de-0000-7000-8000-000000000001', tx)).resolves.toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
