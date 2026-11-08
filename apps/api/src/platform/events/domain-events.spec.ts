import { describe, expect, it } from 'vitest';
import type { Transaction } from '../../database/sql.js';
import { DomainEvents } from './domain-events.js';

class Placed {
  constructor(readonly id: string) {}
}
class Edited {
  constructor(readonly id: string) {}
}

const tx = { marker: 'publisher-tx' } as unknown as Transaction;

describe('DomainEvents', () => {
  it('calls every handler of the event class with the publisher transaction, in registration order', async () => {
    const events = new DomainEvents();
    const calls: string[] = [];
    events.on(
      Placed,
      async (given, event) => {
        await Promise.resolve();
        expect(given).toBe(tx);
        calls.push(`a:${event.id}`);
      },
      'a',
    );
    events.on(Placed, (_given, event) => void calls.push(`b:${event.id}`), 'b');
    events.on(Edited, () => void calls.push('edited'), 'c');

    await events.publish(tx, new Placed('1'));

    expect(calls).toEqual(['a:1', 'b:1']);
    expect(events.ownersOf(Placed)).toEqual(['a', 'b']);
  });

  it('awaits a handler before it calls the next one', async () => {
    const events = new DomainEvents();
    const calls: string[] = [];
    events.on(
      Placed,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push('slow');
      },
      'slow',
    );
    events.on(Placed, () => void calls.push('fast'), 'fast');

    await events.publish(tx, new Placed('1'));

    expect(calls).toEqual(['slow', 'fast']);
  });

  it('stops at a throwing handler and passes its error to the publisher, so the change rolls back', async () => {
    const events = new DomainEvents();
    const calls: string[] = [];
    const boom = new Error('projection failed');
    events.on(Placed, () => void calls.push('first'), 'first');
    events.on(
      Placed,
      () => {
        throw boom;
      },
      'bad',
    );
    events.on(Placed, () => void calls.push('never'), 'later');

    await expect(events.publish(tx, new Placed('1'))).rejects.toBe(boom);
    expect(calls).toEqual(['first']);
  });

  it('is a no op for an event nobody listens to', async () => {
    const events = new DomainEvents();

    await expect(events.publish(tx, new Placed('1'))).resolves.toBeUndefined();
  });
});
