import { randomUUID } from 'node:crypto';
import {
  TASK_TYPES,
  TaskListResponse,
  TaskListRow,
  TaskSummary,
  type TaskTypeCode,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module.js';
import { PlatformClock } from '../src/platform/license/platform-clock.js';
import { ExpectedUpdatedAtRequired, SystemNoteRefused } from '../src/tasks/task-errors.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { devDatabaseUrl } from './support.js';

// Two in process apps start one after the other in this file, and the first one's close restores
// the env it found: read the database URL once at load (see apps/api/AGENTS.md).
devDatabaseUrl();

// Spec 0016 milestone 1, the rules the registry's only real type cannot show: it is closed by the
// system alone, so these suites register one fixture type a person may close (with a note required
// outcome) in the in process registry, as a later milestone's types will be, and open its tasks
// through `TasksService`. The fixture is removed again after the suites.
const FIXTURE = 'test.person_task' as TaskTypeCode;

beforeAll(() => {
  Object.assign(TASK_TYPES, {
    [FIXTURE]: {
      module: 'tasks',
      linkedTypes: ['order', 'customer'],
      defaultHat: 'support',
      requiredPermission: 'orders.confirm',
      due: { kind: 'none' },
      outcomes: ['handled', 'needs_note'],
      noteRequiredOutcomes: ['needs_note'],
      closedBy: 'person',
      openableByPerson: false,
      label: 'tasks.types.sync.write_back_failed',
      outcomeLabels: {
        handled: 'tasks.outcomes.synced',
        needs_note: 'tasks.outcomes.resolved',
      },
    },
  });
});

afterAll(() => {
  delete (TASK_TYPES as Record<string, unknown>)[FIXTURE];
});

describe('tasks, the queue and close rules', { timeout: 180_000 }, () => {
  let api: InProcessApi;
  let connection: DatabaseConnection;
  let tasks: TasksService;
  let agent = '';
  let agentId = '';
  let colleague = '';
  let warehouse = '';

  const system = { kind: 'system_job' } as const;
  /** Opens a fixture task in its own transaction. */
  const open = (
    extra: { assigneeId?: string; dedupeKey?: string } = {},
    linkedId: string = randomUUID(),
  ) =>
    connection.db.transaction((tx) =>
      tasks.open(tx, {
        type: FIXTURE,
        linked: { type: 'order', id: linkedId },
        by: system,
        ...extra,
      }),
    );
  const mine = async (cookie: string, cursor?: string) => {
    const reply = await api.call(
      cookie,
      'GET',
      `/api/tasks?view=mine${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return TaskListResponse.parse(reply.body);
  };
  const owner = <T extends object>(text: string, values: unknown[] = []) =>
    api.owner.pool.query<T & Record<string, unknown>>(text, values);
  /** Cancels what a test left open, so the next one starts from an empty queue. */
  const clear = () =>
    owner(
      `UPDATE tasks SET status = 'cancelled', closed_at = now()
        WHERE type = $1 AND status = 'open'`,
      [FIXTURE],
    );

  beforeAll(async () => {
    api = await startInProcessApi();
    connection = api.app.get<DatabaseConnection>(DATABASE);
    tasks = api.app.get(TasksService);
    const agentPerson = await api.addPerson(['support']);
    agentId = agentPerson.id;
    agent = await api.signIn(agentPerson.email);
    colleague = await api.signIn((await api.addPerson(['support'])).email);
    warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('opens one row for two transactions racing on one dedupe key, and both get it', async () => {
    const dedupeKey = `race:${randomUUID()}`;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const linked = randomUUID();

    // The first transaction holds its insert open while the second starts: the second must wait
    // for it (the partial unique index), find the winner, and answer it instead of a second row.
    const first = connection.db.transaction(async (tx) => {
      const result = await tasks.open(tx, {
        type: FIXTURE,
        linked: { type: 'order', id: linked },
        dedupeKey,
        by: system,
      });
      await sleep(500);
      return result;
    });
    await sleep(150);
    const second = connection.db.transaction((tx) =>
      tasks.open(tx, {
        type: FIXTURE,
        linked: { type: 'order', id: linked },
        dedupeKey,
        by: system,
      }),
    );
    const [a, b] = await Promise.all([first, second]);

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.task.id).toBe(a.task.id);
    const rows = await owner(`SELECT id FROM tasks WHERE dedupe_key = $1`, [dedupeKey]);
    expect(rows.rows).toHaveLength(1);
    await clear();
  });

  it('answers 200 to one of two parallel closes with one token and 409 TASK_CHANGED to the other', async () => {
    await open({ assigneeId: agentId });
    const row = (await mine(agent)).rows[0] as TaskListRow;
    expect(row.allowedOutcomes).toEqual(['handled', 'needs_note']);
    const body = { outcome: 'handled', expectedUpdatedAt: row.updatedAt };

    const replies = await Promise.all([
      api.call(agent, 'POST', `/api/tasks/${row.id}/close`, body),
      api.call(agent, 'POST', `/api/tasks/${row.id}/close`, body),
    ]);

    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const loser = replies.find((reply) => reply.status === 409);
    expect(loser?.body).toMatchObject({ code: 'TASK_CHANGED' });
    const won = TaskListRow.parse(replies.find((reply) => reply.status === 200)?.body);
    expect(won).toMatchObject({ status: 'done', outcomeCode: 'handled' });
    const entries = await owner(`SELECT id FROM audit_entries WHERE record_id = $1::uuid`, [
      row.id,
    ]);
    expect(entries.rows).toHaveLength(1);
  });

  it('keeps a note out of every answer and audit entry, and needs one for a note required outcome', async () => {
    await open({ assigneeId: agentId });
    const row = (await mine(agent)).rows[0] as TaskListRow;
    const sentinel = 'Sentinel customer wants 01009998877 at 7 Sentinel Street';

    const without = await api.call(agent, 'POST', `/api/tasks/${row.id}/close`, {
      outcome: 'needs_note',
      expectedUpdatedAt: row.updatedAt,
    });
    expect(without.status).toBe(422);
    expect(without.body).toMatchObject({ code: 'NOTE_REQUIRED' });

    const done = await api.call(agent, 'POST', `/api/tasks/${row.id}/close`, {
      outcome: 'needs_note',
      note: sentinel,
      expectedUpdatedAt: row.updatedAt,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(JSON.stringify(done.body)).not.toContain('Sentinel');
    expect(JSON.stringify((await mine(agent)).rows)).not.toContain('Sentinel');

    const audit = await owner<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_entries a`,
    );
    expect(audit.rows.map((r) => r.text).join('\n')).not.toContain('Sentinel');
    expect(audit.rows.map((r) => r.text).join('\n')).not.toContain('01009998877');
    // The note is kept only where notes live: one append only row, and never on the task row.
    const notes = await owner<{ note: string; author_id: string }>(
      `SELECT note, author_id FROM task_notes WHERE task_id = $1::uuid`,
      [row.id],
    );
    expect(notes.rows).toEqual([{ note: sentinel, author_id: agentId }]);
    const column = await owner<{ note: string | null }>(
      `SELECT note FROM tasks WHERE id = $1::uuid`,
      [row.id],
    );
    expect(column.rows[0]?.note).toBeNull();
  });

  it('refuses a close with no token for a person, and a note from the system', async () => {
    const { task } = await open({ assigneeId: agentId });

    await expect(
      connection.db.transaction((tx) =>
        tasks.close(tx, task.id, { outcome: 'handled', by: { kind: 'person', userId: agentId } }),
      ),
    ).rejects.toBeInstanceOf(ExpectedUpdatedAtRequired);
    await expect(
      connection.db.transaction((tx) =>
        tasks.close(tx, task.id, { outcome: 'handled', note: 'x', by: system }),
      ),
    ).rejects.toBeInstanceOf(SystemNoteRefused);
    await clear();
  });

  it('answers null from closeByKey when the key was never opened or its task is closed', async () => {
    const dedupeKey = `bykey:${randomUUID()}`;
    const close = () =>
      connection.db.transaction((tx) =>
        tasks.closeByKey(tx, dedupeKey, { outcome: 'handled', by: system }),
      );

    expect(await close()).toBeNull();
    await open({ dedupeKey });
    expect(await close()).toMatchObject({ status: 'done', outcomeCode: 'handled' });
    expect(await close()).toBeNull();
  });

  it('falls a task back to the hat queue when its assignee is disabled or lost the permission', async () => {
    await clear();
    const banned = await api.addPerson(['support']);
    const demoted = await api.addPerson(['support']);
    await open({ assigneeId: banned.id });
    await open({ assigneeId: demoted.id });
    expect((await mine(colleague)).rows).toHaveLength(0);

    await owner(`UPDATE users SET banned = true WHERE id = $1::uuid`, [banned.id]);
    // The second person keeps one hat (warehouse), but no longer wears the one holding orders.confirm.
    await owner(`INSERT INTO hat_assignments (user_id, hat) VALUES ($1::uuid, 'warehouse')`, [
      demoted.id,
    ]);
    await owner(`DELETE FROM hat_assignments WHERE user_id = $1::uuid AND hat = 'support'`, [
      demoted.id,
    ]);

    const page = await mine(colleague);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((r) => r.ownerUserId).sort()).toEqual([banned.id, demoted.id].sort());
    // The warehouse person holds no orders.confirm: the type does not exist for her.
    expect((await mine(warehouse)).rows).toHaveLength(0);
    await clear();
  });

  it('pages rows with no due time and with tied due times without skipping or repeating', async () => {
    await clear();
    const pager = await api.addPerson(['support']);
    const cookie = await api.signIn(pager.email);
    // 25 without a due time, 20 sharing one due time (and one created_at: one statement), 15 apart.
    await owner(
      `INSERT INTO tasks (type, linked_type, linked_id, owner_user_id, owner_hat, due_at, created_by_type)
       SELECT $1, 'order', gen_random_uuid(), $2::uuid, 'support',
              CASE WHEN n <= 25 THEN NULL
                   WHEN n <= 45 THEN timestamptz '2027-03-01 10:00:00+00'
                   ELSE timestamptz '2027-03-02 10:00:00+00' + (n - 45) * interval '1 minute' END,
              'system_job'
         FROM generate_series(1, 60) AS n`,
      [FIXTURE, pager.id],
    );

    const first = await mine(cookie);
    expect(first.rows).toHaveLength(50);
    const second = await mine(cookie, first.nextCursor as string);
    expect(second.rows).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    const all = [...first.rows, ...second.rows];

    expect(new Set(all.map((r) => r.id)).size).toBe(60);
    const key = (r: TaskListRow) =>
      [r.dueAt === null ? 1 : 0, r.dueAt ?? '', r.createdAt, r.id].join('|');
    expect(all.map(key)).toEqual(all.map(key).sort());
    expect(all.slice(0, 35).every((r) => r.dueAt !== null)).toBe(true);
    expect(all.slice(35).every((r) => r.dueAt === null)).toBe(true);
    await clear();
  });

  it('answers 400 INVALID_QUERY to a bad cursor, also from a person who sees no type', async () => {
    for (const cookie of [agent, warehouse]) {
      const reply = await api.call(cookie, 'GET', '/api/tasks?view=mine&cursor=garbage');
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ code: 'INVALID_QUERY' });
    }
  });
});

describe('tasks, "due today" at the brand time zone midnight', { timeout: 120_000 }, () => {
  // 23:30 on 10 July 2027 in Cairo (UTC+3 in summer) is 20:30 UTC.
  const NOW = new Date('2027-07-10T20:30:00Z');
  let api: InProcessApi;
  let cookie = '';
  let personId = '';

  beforeAll(async () => {
    api = await startInProcessApi((builder) => {
      builder.overrideProvider(PlatformClock).useValue({ now: () => Promise.resolve(NOW) });
    });
    const person = await api.addPerson(['support']);
    personId = person.id;
    cookie = await api.signIn(person.email);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('counts a task due 23:59 local as today and one due 00:10 next day as later, though both are the same UTC date', async () => {
    const due = [
      '2027-07-10T20:29:00Z', // 23:29 local, an hour before now's half hour: overdue and today
      '2027-07-10T20:59:00Z', // 23:59 local: today
      '2027-07-10T21:00:00Z', // 00:00 local the next day: later
      '2027-07-10T21:10:00Z', // 00:10 local the next day: later
    ];
    for (const at of due) {
      await api.owner.pool.query(
        `INSERT INTO tasks (type, linked_type, linked_id, owner_user_id, owner_hat, due_at, created_by_type)
         VALUES ($1, 'order', gen_random_uuid(), $2::uuid, 'support', $3::timestamptz, 'system_job')`,
        [FIXTURE, personId, at],
      );
    }

    const reply = await api.call(cookie, 'GET', '/api/tasks/summary');

    expect(TaskSummary.parse(reply.body)).toMatchObject({
      mine: { open: 4, overdue: 1, dueToday: 2 },
    });
  });
});
