import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInLockout, SLOT_RETRY_MS, SLOT_WAIT_MS } from './sign-in-lockout.js';

// The pause between tries is replaced by one that only moves a fake clock, so the wait for the
// email's turn can be run in full without real time passing.
let clock = 0;
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn((ms: number) => {
    clock += ms;
    return Promise.resolve();
  }),
}));

const SLOT = '0190c0de-0000-7000-8000-0000000000aa';
const FAILURE = { emailKey: 'sam@example.com', ip: '203.0.113.7' };
const OUTCOME = { pairLocked: true, emailLocked: false };

/** A PostgreSQL error as `pg` raises it, with its SQLSTATE. */
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

/**
 * A fake database. `transaction` runs the callback with a fake transaction whose `execute`
 * answers with `answers` in turn, and counts how many transactions are open at once.
 */
function fakeDatabase(answers: () => { rows: unknown[] }) {
  let open = 0;
  const opened: number[] = [];
  const tx = { execute: vi.fn(() => Promise.resolve(answers())) };
  const db = {
    execute: vi.fn(() => Promise.resolve({ rows: [] })),
    transaction: vi.fn(async (work: (t: typeof tx) => Promise<unknown>) => {
      open += 1;
      opened.push(open);
      try {
        return await work(tx);
      } finally {
        open -= 1;
      }
    }),
  };
  return {
    db,
    tx,
    opened,
    isOpen: () => open > 0,
    lockout: new SignInLockout({ db, pool: {} } as never),
  };
}

beforeEach(() => {
  clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.mocked(sleep)
    .mockReset()
    .mockImplementation(((ms: number) => {
      clock += ms;
      return Promise.resolve();
    }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('taking a slot (spec 0005, AC-3)', () => {
  it('waits for the email turn with no transaction open, and takes the slot once it is free', async () => {
    let tries = 0;
    const answers = [{ rows: [{ id: SLOT, locked: false }] }];
    const fake = fakeDatabase(() => {
      // The first two tries find the turn taken; the third wins it and reads the counters.
      if (tries < 3) {
        tries += 1;
        return { rows: [{ won: tries === 3 }] };
      }
      return answers.shift() ?? { rows: [] };
    });
    vi.mocked(sleep).mockImplementation(((ms: number) => {
      // A pause never holds a connection: no transaction is open while it runs.
      expect(fake.isOpen()).toBe(false);
      clock += ms;
      return Promise.resolve();
    }) as never);

    await expect(fake.lockout.takeSlot('sam@example.com', '203.0.113.7')).resolves.toEqual({
      slot: SLOT,
    });

    expect(fake.db.transaction).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // One try per transaction, never two at once.
    expect(Math.max(...fake.opened)).toBe(1);
  });

  it('turns the request away, not checked and not counted, once the wait runs out', async () => {
    const fake = fakeDatabase(() => ({ rows: [{ won: false }] }));

    await expect(fake.lockout.takeSlot('sam@example.com', '203.0.113.7')).resolves.toEqual({
      slot: null,
      locked: false,
    });

    // It tried many times, each pause short, and waited the whole wait and no longer.
    expect(fake.db.transaction.mock.calls.length).toBeGreaterThan(
      SLOT_WAIT_MS / (2 * SLOT_RETRY_MS),
    );
    const pauses = vi.mocked(sleep).mock.calls.map((call) => call[0] as number);
    expect(Math.max(...pauses)).toBeLessThanOrEqual(SLOT_RETRY_MS * 1.5);
    expect(clock).toBe(SLOT_WAIT_MS);
    // A lost try runs only the lock statement: no counter read and no slot insert.
    expect(fake.tx.execute).toHaveBeenCalledTimes(fake.db.transaction.mock.calls.length);
  });

  it('reports a running lock when the turn is won but no slot is free', async () => {
    const answers = [{ rows: [{ won: true }] }, { rows: [{ id: null, locked: true }] }];
    const fake = fakeDatabase(() => answers.shift() ?? { rows: [] });

    await expect(fake.lockout.takeSlot('sam@example.com', '203.0.113.7')).resolves.toEqual({
      slot: null,
      locked: true,
    });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('a counted give back (spec 0005, AC-3)', () => {
  it.each(['40P01', '40001'])(
    'is tried once more after %s, and counts the failure',
    async (code) => {
      const fake = fakeDatabase(() => ({ rows: [] }));
      fake.db.transaction.mockRejectedValueOnce(pgError(code)).mockResolvedValueOnce(OUTCOME);

      await expect(fake.lockout.giveBack(SLOT, FAILURE)).resolves.toEqual(OUTCOME);

      expect(fake.db.transaction).toHaveBeenCalledTimes(2);
      // Never an uncounted give back in its place.
      expect(fake.db.execute).not.toHaveBeenCalled();
    },
  );

  it('fails after the second try, still never giving the slot back uncounted', async () => {
    const fake = fakeDatabase(() => ({ rows: [] }));
    fake.db.transaction
      .mockRejectedValueOnce(pgError('40P01'))
      .mockRejectedValueOnce(pgError('40P01'));

    await expect(fake.lockout.giveBack(SLOT, FAILURE)).rejects.toMatchObject({ code: '40P01' });

    expect(fake.db.transaction).toHaveBeenCalledTimes(2);
    expect(fake.db.execute).not.toHaveBeenCalled();
  });

  it('does not retry an error that a second try cannot fix', async () => {
    const fake = fakeDatabase(() => ({ rows: [] }));
    fake.db.transaction.mockRejectedValueOnce(pgError('23505'));

    await expect(fake.lockout.giveBack(SLOT, FAILURE)).rejects.toMatchObject({ code: '23505' });

    expect(fake.db.transaction).toHaveBeenCalledTimes(1);
    expect(fake.db.execute).not.toHaveBeenCalled();
  });

  it('removes the slot and adds the failure in one transaction', async () => {
    const answers = [
      { rows: [] },
      {
        rows: [
          { scope: '*', failures: 1 },
          { scope: FAILURE.ip, failures: 5 },
        ],
      },
    ];
    const fake = fakeDatabase(() => answers.shift() ?? { rows: [] });

    await expect(fake.lockout.giveBack(SLOT, FAILURE)).resolves.toEqual(OUTCOME);

    expect(fake.db.transaction).toHaveBeenCalledTimes(1);
    expect(fake.tx.execute).toHaveBeenCalledTimes(2);
  });
});

describe('forgetting the failures after a full sign in', () => {
  it('locks the rows in order before deleting them, and retries once on a deadlock', async () => {
    const fake = fakeDatabase(() => ({ rows: [] }));
    fake.db.transaction.mockRejectedValueOnce(pgError('40P01'));

    await fake.lockout.reset('sam@example.com');

    expect(fake.db.transaction).toHaveBeenCalledTimes(2);
    expect(fake.tx.execute).toHaveBeenCalledTimes(2);
  });
});
