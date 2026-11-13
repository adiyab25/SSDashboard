import { describe, expect, it, vi } from 'vitest';
import {
  OutboundCommandFailed,
  OutboundCommandResolved,
  OutboundCommandSynced,
} from '../../connectors/connectors.events.js';
import type { Transaction } from '../../database/sql.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import type { TasksService } from '../tasks.service.js';
import { subjectKeyOf, WriteBackFailedListener } from './write-back-failed.listener.js';

const TX = {} as Transaction;
const COMMAND = '00000000-0000-7000-8000-0000000000c1';
const ORDER = '00000000-0000-7000-8000-0000000000a1';
const EDITOR = '00000000-0000-7000-8000-0000000000e1';

function build(eligible: string[]) {
  const open = vi.fn((_tx: Transaction, _input: object) =>
    Promise.resolve({ task: {}, created: true }),
  );
  const closeByKey = vi.fn((_tx: Transaction, _key: string, _change: object) =>
    Promise.resolve(null),
  );
  const tasks = {
    open,
    closeByKey,
    eligibleFor: () => Promise.resolve(new Set(eligible)),
  } as unknown as TasksService;
  const events = new DomainEvents();
  new WriteBackFailedListener(events, tasks).onModuleInit();
  return { events, open, closeByKey };
}

const failedEvent = (queuedBy: string | null, code: string | null = 'STEP_OFF') =>
  new OutboundCommandFailed(COMMAND, 'conn', 'shopify.order_edit', 'order', ORDER, code, queuedBy);

describe('WriteBackFailedListener (spec 0016 AC-8)', () => {
  it('opens the task on the linked record with the dedupe and subject keys, due by the registry', async () => {
    const { events, open } = build([EDITOR]);

    await events.publish(TX, failedEvent(null));

    expect(open).toHaveBeenCalledWith(TX, {
      type: 'sync.write_back_failed',
      linked: { type: 'order', id: ORDER },
      subjectKey: 'shopify.order_edit:step_off',
      dedupeKey: `outbound_command_failed:${COMMAND}`,
      by: { kind: 'system_job' },
    });
  });

  it('assigns the person who queued the command when she may hold the type', async () => {
    const { events, open } = build([EDITOR]);

    await events.publish(TX, failedEvent(EDITOR));

    expect(open).toHaveBeenCalledWith(TX, expect.objectContaining({ assigneeId: EDITOR }));
  });

  it('leaves it unassigned when she is not eligible (disabled, or without orders.confirm)', async () => {
    const { events, open } = build([]);

    await events.publish(TX, failedEvent(EDITOR));

    expect(open.mock.calls[0]?.[1]).not.toHaveProperty('assigneeId');
  });

  it('closes by key with the system outcomes on a sync and a resolve', async () => {
    const { events, closeByKey } = build([]);

    await events.publish(TX, new OutboundCommandSynced(COMMAND, 'conn', 'k', 'order', ORDER));
    await events.publish(TX, new OutboundCommandResolved(COMMAND, 'conn', 'k', 'order', ORDER));

    expect(closeByKey.mock.calls).toEqual([
      [TX, `outbound_command_failed:${COMMAND}`, { outcome: 'synced', by: { kind: 'system_job' } }],
      [
        TX,
        `outbound_command_failed:${COMMAND}`,
        { outcome: 'resolved', by: { kind: 'system_job' } },
      ],
    ]);
  });

  it('never swallows a failure to open: the publisher must roll back', async () => {
    const { events, open } = build([]);
    open.mockRejectedValueOnce(new Error('boom'));

    await expect(events.publish(TX, failedEvent(null))).rejects.toThrow('boom');
  });

  it('builds a subject key in the key shape', () => {
    expect(subjectKeyOf('Shopify.Order_Edit', 'STEP_OFF')).toBe('shopify.order_edit:step_off');
    expect(subjectKeyOf('shopify.order_edit', null)).toBe('shopify.order_edit:unknown');
    expect(subjectKeyOf('a b', 'X/Y')).toBe('a_b:x_y');
    expect(subjectKeyOf('k'.repeat(200), 'x')).toHaveLength(120);
  });
});
