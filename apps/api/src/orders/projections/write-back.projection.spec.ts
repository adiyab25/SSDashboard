import { describe, expect, it } from 'vitest';
import {
  OutboundCommandFailed,
  OutboundCommandQueued,
  OutboundCommandResolved,
  OutboundCommandSynced,
} from '../../connectors/connectors.events.js';
import type { ConnectorsService, OpenCommand } from '../../connectors/connectors.service.js';
import type { Transaction } from '../../database/sql.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import type { OrderWriter } from '../writer/order-writer.js';
import { WriteBackProjection, writeBackStateOf } from './write-back.projection.js';

const ORDER = '01937f3a-0000-7000-8000-000000000001';
const command = (syncState: 'waiting' | 'failed'): OpenCommand => ({
  id: '01937f3a-0000-7000-8000-000000000009',
  connectionId: '01937f3a-0000-7000-8000-000000000008',
  kind: 'shopify.order_edit',
  syncState,
  failureReason: syncState === 'failed' ? 'STEP_OFF' : null,
  queuedAt: '2026-11-08T10:00:00.000000Z',
});

/** The projection over an events service, with fake connectors and writer that record calls. */
function setup(open: OpenCommand[]) {
  const events = new DomainEvents();
  const asked: string[] = [];
  const written: [string, string][] = [];
  const steps: string[] = [];
  const connectors = {
    openCommandsFor: (_type: string, id: string) => {
      asked.push(id);
      steps.push('read commands');
      return Promise.resolve(open);
    },
  } as unknown as ConnectorsService;
  // Stands in for the writer's lock, read, write order: the lock is taken before `stateOf` runs.
  const writer = {
    projectWriteBackState: async (_tx: Transaction, id: string, stateOf: () => Promise<string>) => {
      steps.push('lock order');
      const state = await stateOf();
      steps.push('write state');
      written.push([id, state]);
    },
  } as unknown as OrderWriter;
  const projection = new WriteBackProjection(events, connectors, writer);
  projection.onModuleInit();
  return { events, asked, written, steps };
}

const tx = {} as Transaction;

describe('the write back projection (spec 0013 AC-12)', () => {
  it('ranks failed over waiting over none', () => {
    expect(writeBackStateOf([])).toBe('none');
    expect(writeBackStateOf([command('waiting')])).toBe('waiting');
    expect(writeBackStateOf([command('waiting'), command('failed')])).toBe('failed');
  });

  it('recomputes the order state from its open commands on each of the four events', async () => {
    const { events, written } = setup([command('waiting')]);
    const args = ['c', 'k', 'shopify.order_edit', 'order', ORDER] as const;

    await events.publish(tx, new OutboundCommandQueued(...args));
    await events.publish(tx, new OutboundCommandSynced(...args));
    await events.publish(tx, new OutboundCommandFailed(...args, 'STEP_OFF'));
    await events.publish(tx, new OutboundCommandResolved(...args));

    expect(written).toEqual([
      [ORDER, 'waiting'],
      [ORDER, 'waiting'],
      [ORDER, 'waiting'],
      [ORDER, 'waiting'],
    ]);
    expect(events.ownersOf(OutboundCommandSynced)).toEqual(['orders']);
  });

  it('reads the commands only after the writer has locked the order row', async () => {
    const { events, steps } = setup([command('failed')]);

    await events.publish(
      tx,
      new OutboundCommandFailed('c', 'k', 'shopify.order_edit', 'order', ORDER),
    );

    expect(steps).toEqual(['lock order', 'read commands', 'write state']);
  });

  it('ignores a command that is not about an order', async () => {
    const { events, asked, written } = setup([]);

    await events.publish(
      tx,
      new OutboundCommandQueued('c', 'k', 'shopify.customer', 'customer', ORDER),
    );

    expect(asked).toEqual([]);
    expect(written).toEqual([]);
  });
});
