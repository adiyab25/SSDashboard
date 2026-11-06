import type { SQL } from '@ssdashboard/db';
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

/**
 * The statement as text with `$n` for each bound value, and the values: Drizzle keeps the literal
 * parts as string chunks and an interpolated value as itself.
 */
function rendered(query: SQL): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let text = '';
  for (const chunk of query.queryChunks as unknown[]) {
    const literal = (chunk as { value?: unknown } | null)?.value;
    if (Array.isArray(literal)) {
      text += literal.join('');
    } else {
      params.push(chunk);
      text += `$${params.length}`;
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), params };
}

describe('revokeSessions (AC-33 c)', () => {
  const USER_ID = '0190c0de-0000-7000-8000-000000000001';

  function fakeTx() {
    const execute = vi.fn((_query: SQL) => Promise.resolve({ rowCount: 2, rows: [] }));
    return { tx: { execute } as unknown as Transaction, execute };
  }

  it('deletes the person’s sessions through the caller’s transaction, and counts them', async () => {
    const { tx, execute } = fakeTx();

    await expect(revokeSessions(USER_ID, tx)).resolves.toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('deletes only that person’s rows: the WHERE names user_id and binds their id', async () => {
    const { tx, execute } = fakeTx();

    await revokeSessions(USER_ID, tx);

    const query = execute.mock.calls[0]?.[0];
    if (!query) throw new Error('no statement ran');
    const { text, params } = rendered(query);
    expect(text).toBe('DELETE FROM sessions WHERE user_id = $1::uuid');
    expect(params).toEqual([USER_ID]);
  });
});
