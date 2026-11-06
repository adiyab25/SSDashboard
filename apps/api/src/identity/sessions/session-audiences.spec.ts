import type { Hat } from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import {
  audiencesOfHats,
  HatSessionAudiences,
  homeOf,
  type SessionAudience,
} from './session-audiences.js';

describe('audiencesOfHats (spec 0008, AC-10)', () => {
  it.each<[Hat[], SessionAudience[]]>([
    [['warehouse'], ['staff']],
    [['support', 'manager'], ['staff']],
    [['media_buyer'], ['staff']],
    [['partner'], ['partner']],
    // The hat rules keep the partner hat alone; if a row ever breaks that, partner wins.
    [['partner', 'manager'], ['partner']],
    [[], []],
  ])('gives %j the audiences %j', (hats, audiences) => {
    expect([...audiencesOfHats(hats)]).toEqual(audiences);
  });
});

describe('HatSessionAudiences (spec 0005, AC-29)', () => {
  function withHats(hats: Hat[]) {
    const execute = vi.fn(() => Promise.resolve({ rows: hats.map((hat) => ({ hat })) }));
    const connection = { db: { execute } } as unknown as DatabaseConnection;
    return { audiences: new HatSessionAudiences(connection), execute };
  }

  it('reads the hats on every call and caches nothing', async () => {
    const { audiences, execute } = withHats(['warehouse']);

    expect([...(await audiences.audiencesFor('0190c0de-0000-7000-8000-000000000001'))]).toEqual([
      'staff',
    ]);
    await audiences.audiencesFor('0190c0de-0000-7000-8000-000000000001');

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('answers no audience for a person with no hat', async () => {
    const { audiences } = withHats([]);

    expect((await audiences.audiencesFor('0190c0de-0000-7000-8000-000000000001')).size).toBe(0);
  });
});

describe('homeOf (AC-28)', () => {
  it.each<[SessionAudience[], string]>([
    [['staff'], 'backoffice'],
    [['partner'], 'partner'],
    [[], 'backoffice'],
  ])('sends %j to %s', (audiences, home) => {
    expect(homeOf(new Set(audiences))).toBe(home);
  });
});
