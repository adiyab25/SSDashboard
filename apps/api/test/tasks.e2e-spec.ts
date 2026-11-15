import { randomUUID } from 'node:crypto';
import {
  CreatedOrder,
  SkuDetail,
  TaskListResponse,
  TaskListRow,
  TaskSummary,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OutboundCommandFailed,
  OutboundCommandResolved,
  OutboundCommandSynced,
} from '../src/connectors/connectors.events.js';
import { DATABASE } from '../src/database/database.module.js';
import { HatDirectory } from '../src/identity/hats/hat-directory.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0016 milestone 1, "Done when": a failed write back (published as a fixture connector would,
// inside a transaction through DomainEvents; the outbound side is a stand in until spec 0015 task
// 13) puts one task on the editing agent's My work, every `orders.confirm` holder's count shows it,
// a brand with nobody in operations shows an unassigned one to the manager, the sync closes it with
// one `task.closed` entry by the system, and a listener that throws rolls the publisher back.
// `task.closed` is the action this file proves for the audit registry.
describe('tasks (spec 0016 milestone 1)', { timeout: 180_000 }, () => {
  let api: InProcessApi;
  let connection: DatabaseConnection;
  let events: DomainEvents;
  let manager = '';
  let agent = '';
  let agentId = '';
  let colleague = '';
  let warehouse = '';
  let warehouseId = '';
  let mediaBuyer = '';
  let mediaBuyerId = '';
  let orderId = '';

  /** Publishes one event inside a transaction, as the publisher of a command change would. */
  const publish = <E extends object>(event: E) =>
    connection.db.transaction((tx) => events.publish(tx, event));
  const failed = (commandId: string, queuedBy: string | null = null, code = 'STEP_OFF') =>
    publish(
      new OutboundCommandFailed(
        commandId,
        randomUUID(),
        'shopify.order_edit',
        'order',
        orderId,
        code,
        queuedBy,
      ),
    );
  const mine = async (cookie: string) => {
    const reply = await api.call(cookie, 'GET', '/api/tasks?view=mine');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return TaskListResponse.parse(reply.body);
  };
  const summary = async (cookie: string) => {
    const reply = await api.call(cookie, 'GET', '/api/tasks/summary');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return TaskSummary.parse(reply.body);
  };
  const taskRows = async (commandId: string) =>
    (
      await api.owner.pool.query<{
        id: string;
        status: string;
        outcome_code: string | null;
        owner_user_id: string | null;
        owner_hat: string;
        subject_key: string;
        linked_id: string;
        created_by_type: string;
      }>(
        `SELECT id, status, outcome_code, owner_user_id, owner_hat, subject_key, linked_id, created_by_type
           FROM tasks WHERE dedupe_key = $1`,
        [`outbound_command_failed:${commandId}`],
      )
    ).rows;

  beforeAll(async () => {
    api = await startInProcessApi();
    connection = api.app.get<DatabaseConnection>(DATABASE);
    events = api.app.get(DomainEvents);
    manager = await api.signIn((await api.addPerson(['manager'])).email);
    const agentPerson = await api.addPerson(['support']);
    agentId = agentPerson.id;
    agent = await api.signIn(agentPerson.email);
    colleague = await api.signIn((await api.addPerson(['support'])).email);
    const warehousePerson = await api.addPerson(['warehouse']);
    warehouseId = warehousePerson.id;
    warehouse = await api.signIn(warehousePerson.email);
    const buyerPerson = await api.addPerson(['media_buyer']);
    mediaBuyerId = buyerPerson.id;
    mediaBuyer = await api.signIn(buyerPerson.email);

    // A real order to point the write back at (the orders projection locks it on every event).
    const store = (
      await api.owner.pool.query<{ id: string }>(`SELECT id FROM stores WHERE code = 'MAIN'`)
    ).rows[0]?.id as string;
    const channel = (
      await api.owner.pool.query<{ id: string }>(`SELECT id FROM channels WHERE code = 'manual'`)
    ).rows[0]?.id as string;
    const sku = await api.call(manager, 'POST', '/api/products', {
      name: { en: 'Task tee' },
      variants: [{ sku: 'TASK-M', price: '100.00' }],
    });
    const variantId = SkuDetail.parse(sku.body).id;
    const made = await api.call(agent, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: store,
      channelId: channel,
      shipTo: { name: 'Task Customer', phone: '01009998877', address: '1 Task Street' },
      lines: [{ variantId, quantity: 1, unitPrice: '100.00' }],
      shippingChargedAmount: '20.00',
      paymentMethod: 'cod',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    orderId = CreatedOrder.parse(made.body).id;
  });

  afterAll(async () => {
    await api?.close();
  });

  it('opens one task on the editing agent, counts it for every orders.confirm holder, and answers a link without personal data', async () => {
    const commandId = randomUUID();
    await failed(commandId, agentId);

    const rows = await taskRows(commandId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'open',
      owner_user_id: agentId,
      owner_hat: 'operations',
      subject_key: 'shopify.order_edit:step_off',
      linked_id: orderId,
      created_by_type: 'system_job',
    });

    const page = await mine(agent);
    expect(page.rows).toHaveLength(1);
    const row = TaskListRow.parse(page.rows[0]);
    expect(row).toMatchObject({
      type: 'sync.write_back_failed',
      linkedType: 'order',
      linkedId: orderId,
      ownerHat: 'operations',
      ownerUserId: agentId,
      status: 'open',
      overdue: true,
      heldBy: null,
      allowedOutcomes: [],
      link: { kind: 'order', id: orderId, path: `/orders/${orderId}` },
    });
    expect(row.ownerName).toMatch(/^Planted Person/);
    expect(row.link.label?.kind).toBe('order');
    const text = JSON.stringify(page);
    expect(text).not.toContain('Task Customer');
    expect(text).not.toContain('01009998877');
    expect(text).not.toContain('Task Street');

    expect(await summary(agent)).toEqual({
      mine: { open: 1, overdue: 1, dueToday: 1 },
      unsyncedEdits: 1,
    });
    // Another person with orders.confirm sees the count but not the row; the manager too (the
    // operations hat has nobody, but this task is assigned, so it is not an orphan).
    expect(await summary(colleague)).toEqual({
      mine: { open: 0, overdue: 0, dueToday: 0 },
      unsyncedEdits: 1,
    });
    expect((await mine(colleague)).rows).toHaveLength(0);
    expect(await summary(manager)).toMatchObject({ unsyncedEdits: 1 });
    expect((await mine(manager)).rows).toHaveLength(0);
    // Warehouse holds tasks.work but not orders.confirm: no count, no row.
    expect(await summary(warehouse)).toEqual({ mine: { open: 0, overdue: 0, dueToday: 0 } });
    expect((await mine(warehouse)).rows).toHaveLength(0);

    // Publishing the same failure again opens no second row.
    await failed(commandId, agentId);
    expect(await taskRows(commandId)).toHaveLength(1);
    expect((await summary(agent)).unsyncedEdits).toBe(1);

    // The sync closes it: done, `synced`, one task.closed entry by the system.
    await publish(
      new OutboundCommandSynced(commandId, randomUUID(), 'shopify.order_edit', 'order', orderId),
    );
    const closed = await taskRows(commandId);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ status: 'done', outcome_code: 'synced' });
    const entries = await api.owner.pool.query<{
      action: string;
      actor_kind: string;
      record_type: string;
      reason: string;
      after_text: string;
    }>(
      `SELECT action, actor_kind, record_type, reason, after::text AS after_text
         FROM audit_entries WHERE record_id = $1::uuid`,
      [closed[0]?.id],
    );
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0]).toMatchObject({
      action: 'task.closed',
      actor_kind: 'system_job',
      record_type: 'task',
      reason: 'closed_by_system',
    });
    expect(entries.rows[0]?.after_text).toContain('"outcome": "synced"');
    expect((await mine(agent)).rows).toHaveLength(0);
    expect((await summary(agent)).unsyncedEdits).toBe(0);

    // Closing what is already closed (a resolve after the sync) is a no op.
    await publish(
      new OutboundCommandResolved(commandId, randomUUID(), 'shopify.order_edit', 'order', orderId),
    );
    expect((await taskRows(commandId))[0]).toMatchObject({
      status: 'done',
      outcome_code: 'synced',
    });
  });

  it('shows an unassigned task to the manager while nobody is in operations, and moves it to the hat once someone is', async () => {
    const commandId = randomUUID();
    // The queuing person is a warehouse user without orders.confirm: not assignable, so no owner.
    await failed(commandId, warehouseId);
    const rows = await taskRows(commandId);
    expect(rows[0]).toMatchObject({ owner_user_id: null, owner_hat: 'operations' });

    expect((await mine(manager)).rows.map((r) => r.id)).toContain(rows[0]?.id);
    expect((await mine(agent)).rows).toHaveLength(0);
    expect((await summary(manager)).unsyncedEdits).toBe(1);

    const holders = api.app.get(HatDirectory);
    expect(await holders.holdersOf('operations')).toEqual([]);
    const operationsPerson = await api.addPerson(['operations']);
    const operations = await api.signIn(operationsPerson.email);
    expect(await holders.holdersOf('operations')).toEqual([operationsPerson.id]);
    expect((await mine(manager)).rows).toHaveLength(0);
    expect((await mine(operations)).rows.map((r) => r.id)).toEqual([rows[0]?.id]);

    // A person cannot close it by hand: it is a system task, `synced` is a system outcome.
    const row = (await mine(operations)).rows[0] as TaskListRow;
    const refused = await api.call(operations, 'POST', `/api/tasks/${row.id}/close`, {
      outcome: 'synced',
      expectedUpdatedAt: row.updatedAt,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'OUTCOME_NOT_FOR_PERSON' });
    const unknown = await api.call(operations, 'POST', `/api/tasks/${row.id}/close`, {
      outcome: 'bogus',
      expectedUpdatedAt: row.updatedAt,
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ code: 'OUTCOME_INVALID' });
    const stale = await api.call(operations, 'POST', `/api/tasks/${row.id}/close`, {
      outcome: 'synced',
      expectedUpdatedAt: '2020-01-01T00:00:00.000000Z',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'TASK_CHANGED' });
    const malformed = await api.call(operations, 'POST', `/api/tasks/${row.id}/close`, {
      outcome: 'synced',
      note: 'Sentinel note text',
    });
    expect(malformed.status).toBe(422);
    expect(malformed.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(malformed.body)).not.toContain('Sentinel');
    // A malformed id is a task that does not exist.
    const badId = await api.call(operations, 'POST', '/api/tasks/not-a-uuid/close', {
      outcome: 'synced',
      expectedUpdatedAt: row.updatedAt,
    });
    expect(badId.status).toBe(404);
    expect(badId.body).toMatchObject({ code: 'TASK_NOT_FOUND' });

    // A resolve closes it with the system outcome.
    await publish(
      new OutboundCommandResolved(commandId, randomUUID(), 'shopify.order_edit', 'order', orderId),
    );
    expect((await taskRows(commandId))[0]).toMatchObject({
      status: 'done',
      outcome_code: 'resolved',
    });
  });

  it('reads the active holders of a hat from the hat directory, never a disabled person', async () => {
    const holders = api.app.get(HatDirectory);
    const extra = await api.addPerson(['warehouse']);
    const before = await holders.holdersByHat();

    expect([...before.keys()].sort()).toEqual(['manager', 'operations', 'support', 'warehouse']);
    expect(before.get('warehouse')).toContain(extra.id);
    expect(before.get('support')).toContain(agentId);
    // A hat of an external wearer is never an internal hat.
    expect(JSON.stringify([...before.values()])).not.toContain(mediaBuyerId);

    await api.owner.pool.query(`UPDATE users SET banned = true WHERE id = $1::uuid`, [extra.id]);

    expect(await holders.holdersOf('warehouse')).not.toContain(extra.id);
    expect(await holders.holdersOf('warehouse')).toContain(warehouseId);
  });

  it('answers 404 to a person who cannot see the task and 403 to one without tasks.work', async () => {
    const commandId = randomUUID();
    await failed(commandId, agentId);
    const id = (await taskRows(commandId))[0]?.id as string;
    const body = { outcome: 'synced', expectedUpdatedAt: '2026-11-12T10:00:00.000000Z' };

    // Warehouse holds tasks.work but not the type's permission: the task does not exist for it.
    const hidden = await api.call(warehouse, 'POST', `/api/tasks/${id}/close`, body);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ code: 'TASK_NOT_FOUND' });
    // So does a colleague who is not the assignee and not in the hat.
    expect((await api.call(colleague, 'POST', `/api/tasks/${id}/close`, body)).status).toBe(404);
    expect((await api.call(agent, 'POST', `/api/tasks/${randomUUID()}/close`, body)).status).toBe(
      404,
    );
    expect((await api.call(mediaBuyer, 'GET', '/api/tasks?view=mine')).status).toBe(403);
    expect((await api.call(mediaBuyer, 'GET', '/api/tasks/summary')).status).toBe(403);
    expect((await api.call(mediaBuyer, 'POST', `/api/tasks/${id}/close`, body)).status).toBe(403);

    // The assignee reaches the rules: the answer is the refusal for a person, not a 404.
    const row = (await mine(agent)).rows.find((r) => r.id === id) as TaskListRow;
    const person = await api.call(agent, 'POST', `/api/tasks/${id}/close`, {
      outcome: 'synced',
      expectedUpdatedAt: row.updatedAt,
    });
    expect(person.status).toBe(422);
    expect(person.body).toMatchObject({ code: 'OUTCOME_NOT_FOR_PERSON' });

    // view=team and a bad cursor are milestone 2 and a refused query.
    const team = await api.call(manager, 'GET', '/api/tasks?view=team');
    expect(team.status).toBe(400);
    expect(team.body).toMatchObject({ code: 'INVALID_QUERY' });
    const cursor = await api.call(agent, 'GET', '/api/tasks?view=mine&cursor=garbage');
    expect(cursor.status).toBe(400);
    expect(cursor.body).toMatchObject({ code: 'INVALID_QUERY' });

    await publish(
      new OutboundCommandSynced(commandId, randomUUID(), 'shopify.order_edit', 'order', orderId),
    );
  });

  it('pages My work 50 at a time in due order without skipping or repeating a row', async () => {
    const ids = Array.from({ length: 52 }, () => randomUUID());
    for (const commandId of ids) await failed(commandId, agentId);

    const first = await mine(agent);
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await api.call(
      agent,
      'GET',
      `/api/tasks?view=mine&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    const rest = TaskListResponse.parse(second.body);
    expect(rest.rows).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();
    const seen = [...first.rows, ...rest.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(52);
    const dues = [...first.rows, ...rest.rows].map((r) => r.dueAt as string);
    expect([...dues].sort()).toEqual(dues);
    expect((await summary(agent)).mine.open).toBe(52);

    for (const commandId of ids) {
      await publish(
        new OutboundCommandSynced(commandId, randomUUID(), 'shopify.order_edit', 'order', orderId),
      );
    }
    expect((await mine(agent)).rows).toHaveLength(0);
  });

  it('rolls the publisher back when a listener throws, so no failure exists without its task', async () => {
    const commandId = randomUUID();
    const mark = 'tasks-e2e-poison';
    events.on(
      OutboundCommandFailed,
      (_tx, event) => {
        if (event.failureCode === 'POISON') throw new Error(mark);
      },
      'tasks-e2e',
    );

    await expect(
      connection.db.transaction(async (tx) => {
        await events.publish(
          tx,
          new OutboundCommandFailed(
            commandId,
            randomUUID(),
            'shopify.order_edit',
            'order',
            orderId,
            'POISON',
            agentId,
          ),
        );
      }),
    ).rejects.toThrow(mark);

    expect(await taskRows(commandId)).toHaveLength(0);
  });
});
