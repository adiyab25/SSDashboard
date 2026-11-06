import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0002, customers, credit, and tasks child (build plan item 16): the database guards on
// tasks. The type registry, outcome rules, and idempotent opening are feature 17's TasksService.
describe('tasks (AC-26)', () => {
  let name: string;
  let owner: pg.Client;
  let app: pg.Client;
  let person: string;
  let counter = 0;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    app = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await app.connect();
    await app.query(`SET ROLE ${APP_ROLE}`);
    person = (
      await one<{ id: string }>(
        "INSERT INTO users (name, email) VALUES ('Agent', 'tasks@example.test') RETURNING id",
      )
    ).id;
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await dropScratchDatabase(name);
  });

  async function one<T extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
    client: pg.Client = app,
  ): Promise<T> {
    const { rows } = await client.query<T>(text, values);
    const row = rows[0];
    if (!row) throw new Error(`no row from: ${text}`);
    return row;
  }

  /** Opens a task as the application role (a confirmation call on an order) and returns its id. */
  async function open(overrides: Record<string, unknown> = {}): Promise<string> {
    counter += 1;
    const row: Record<string, unknown> = {
      type: 'confirmation.call',
      linked_type: 'order',
      linked_id: `0192f7a0-0000-7000-8000-${String(counter).padStart(12, '0')}`,
      owner_hat: 'support',
      created_by_type: 'system_job',
      ...overrides,
    };
    const columns = Object.keys(row);
    const params = columns.map((_, index) => `$${index + 1}`);
    return (
      await one<{ id: string }>(
        `INSERT INTO tasks (${columns.join(', ')}) VALUES (${params.join(', ')}) RETURNING id`,
        Object.values(row),
      )
    ).id;
  }

  it('opens a task for a hat and stamps its operating day from created_at', async () => {
    const id = await open();

    const row = await one<{ status: string; same_day: boolean }>(
      'SELECT status, operating_day = ssd_operating_day(created_at) AS same_day FROM tasks WHERE id = $1',
      [id],
    );
    expect(row).toEqual({ status: 'open', same_day: true });
  });

  it('refuses a task that nobody holds, neither a person nor a hat (AC-26)', async () => {
    await expect(open({ owner_hat: null })).rejects.toThrow(/tasks_has_owner/);
    const id = await open();
    await expect(
      app.query('UPDATE tasks SET owner_hat = NULL WHERE id = $1', [id]),
    ).rejects.toThrow(/tasks_has_owner/);
  });

  it('refuses a dedupe key that is not an id shaped key (security review n4)', async () => {
    await expect(open({ dedupe_key: 'call Mona 0100 123 4567' })).rejects.toThrow(
      /tasks_dedupe_key_shape/,
    );
  });

  it('never lets the application role delete or truncate a task (cancel instead)', async () => {
    const id = await open();

    await expect(app.query('DELETE FROM tasks WHERE id = $1', [id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query('TRUNCATE tasks')).rejects.toThrow(/permission denied/);
  });

  it("refuses an external hat as the owner ('partner')", async () => {
    await expect(open({ owner_hat: 'partner' })).rejects.toThrow(/tasks_owner_hat_internal/);
  });

  it('refuses closing without an outcome, and an outcome on an open task', async () => {
    const id = await open();

    await expect(
      app.query("UPDATE tasks SET status = 'done', closed_at = now() WHERE id = $1", [id]),
    ).rejects.toThrow(/tasks_outcome_when_done/);
    await expect(
      app.query("UPDATE tasks SET outcome_code = 'confirmed' WHERE id = $1", [id]),
    ).rejects.toThrow(/tasks_outcome_when_done/);
    await app.query(
      "UPDATE tasks SET status = 'done', outcome_code = 'confirmed', closed_at = now(), closed_by = $2 WHERE id = $1",
      [id, person],
    );
  });

  it('records when a task closed exactly when it is not open', async () => {
    const id = await open();

    await expect(
      app.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [id]),
    ).rejects.toThrow(/tasks_closed_at_when_closed/);
    await expect(open({ closed_at: '2026-11-06T10:00:00Z' })).rejects.toThrow(
      /tasks_closed_at_when_closed/,
    );
    await app.query("UPDATE tasks SET status = 'cancelled', closed_at = now() WHERE id = $1", [id]);
  });

  it('refuses a person as the creator without their id, and a typed note as the type', async () => {
    await expect(open({ created_by_type: 'person' })).rejects.toThrow(/tasks_person_has_creator/);
    await expect(open({ type: 'Call her back' })).rejects.toThrow(/tasks_type_shape/);
    await open({
      created_by_type: 'person',
      created_by: person,
      owner_user_id: person,
      owner_hat: null,
    });
  });

  it('keeps one open task per dedupe key; a closed one does not block a new open one', async () => {
    const dedupe = { dedupe_key: 'outbound_command_failed:42' };
    const first = await open(dedupe);

    await expect(open(dedupe)).rejects.toThrow(/tasks_open_dedupe_key_unique/);

    await app.query(
      "UPDATE tasks SET status = 'done', outcome_code = 'retried', closed_at = now() WHERE id = $1",
      [first],
    );
    await open(dedupe);
  });

  it('refuses a change of the operating day that does not come from created_at', async () => {
    const id = await open();

    await expect(
      app.query("UPDATE tasks SET operating_day = '2020-01-01' WHERE id = $1", [id]),
    ).rejects.toThrow(/tasks_operating_day_follows_created_at/);
    await app.query("UPDATE tasks SET created_at = '2026-01-20T22:30:00Z' WHERE id = $1", [id]);
    const row = await one<{ day: string }>(
      "SELECT to_char(operating_day, 'YYYY-MM-DD') AS day FROM tasks WHERE id = $1",
      [id],
    );
    expect(row.day).toBe('2026-01-21');
  });

  it('has exactly the three partial indexes My work and the dedupe key read (index names only)', async () => {
    const indexes = await one<{ names: string[] }>(
      `SELECT array_agg(indexname::text ORDER BY indexname) AS names FROM pg_indexes
       WHERE tablename = 'tasks' AND indexdef LIKE '%WHERE%'`,
    );

    expect(indexes.names).toEqual([
      'tasks_open_dedupe_key_unique',
      'tasks_open_owner_hat_idx',
      'tasks_open_owner_user_idx',
    ]);
  });
});
