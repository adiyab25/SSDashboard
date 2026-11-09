import { Inject, Injectable } from '@nestjs/common';
import {
  SyncRunView,
  type SyncRunKind,
  type SyncRunListQuery,
  type SyncRunListResponse,
  type SyncRunStatus,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { z } from 'zod';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import {
  decodeTimeIdKeyset,
  encodeKeyset,
  InvalidCursorError,
} from '../../platform/keyset-cursor.js';
import { ConnectionsError } from '../connectors.errors.js';

/**
 * Where an unfinished run stands, kept as JSON text in `connection_sync_runs.cursor` (never
 * answered by a route): `step` counts the run's jobs, so a job whose step the run has moved past is
 * a duplicate and is skipped; `bulkId` is the bulk operation of a gateway scan or backfill run;
 * `line` the JSONL line the next chunk starts at; `mode` `paged` once the orders backfill fell
 * back to paged reads; `after` the page cursor of a sweep or a paged backfill; `since` the instant
 * a gateway scan reads from (fixed at its first step). Never a bulk result address.
 */
export const RunPosition = z.object({
  step: z.number().int().nonnegative(),
  bulkId: z.string().max(200).nullable().default(null),
  line: z.number().int().nonnegative().default(0),
  mode: z.enum(['bulk', 'paged']).default('bulk'),
  after: z.string().max(1000).nullable().default(null),
  since: z.string().max(40).nullable().default(null),
});
/** The parsed RunPosition. */
export type RunPosition = z.infer<typeof RunPosition>;

/** The first position of a run. */
export function firstPosition(): RunPosition {
  return RunPosition.parse({ step: 0 });
}

/** One run as the jobs read it. */
export interface SyncRunRow {
  readonly id: string;
  readonly connectionId: string;
  readonly kind: SyncRunKind;
  readonly status: SyncRunStatus;
  readonly startedAt: string;
  readonly finished: boolean;
  readonly watermarkFrom: string | null;
  readonly position: RunPosition;
  readonly counts: Record<string, unknown>;
}

interface RunRecord extends Record<string, unknown> {
  id: string;
  connection_id: string;
  kind: SyncRunKind;
  status: SyncRunStatus;
  started_at: string;
  finished_at: string | null;
  watermark_from: string | null;
  watermark_to: string | null;
  cursor: string | null;
  counts: unknown;
  cost_points: number;
  error_code: string | null;
}

/** A timestamp column as the api issues it: UTC with microseconds. */
const utc = (column: SQL) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const RUN_COLUMNS = sql`
  id, connection_id, kind, status, ${utc(sql`started_at`)} AS started_at,
  ${utc(sql`finished_at`)} AS finished_at, ${utc(sql`watermark_from`)} AS watermark_from,
  ${utc(sql`watermark_to`)} AS watermark_to, cursor, counts, cost_points, error_code`;

/** A run's counts as an object (a stored value of another shape reads as empty). */
function countsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The position of a stored cursor; a run without one (or an unreadable one) starts again. */
function positionOf(cursor: string | null): RunPosition {
  if (cursor === null) return firstPosition();
  try {
    const parsed = RunPosition.safeParse(JSON.parse(cursor));
    return parsed.success ? parsed.data : firstPosition();
  } catch {
    return firstPosition();
  }
}

/** The counts a route may answer: numbers, flags, codes, and lists of names only. */
function answerableCounts(counts: Record<string, unknown>): SyncRunView['counts'] {
  const kept: SyncRunView['counts'] = {};
  for (const [key, value] of Object.entries(counts)) {
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'string'
    ) {
      kept[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      kept[key] = value;
    }
  }
  return kept;
}

/**
 * The connector's sync runs (`connection_sync_runs`, spec 0015 data model, task 12): the one place
 * the task 12 jobs and routes start, move, finish, and read a run, and the
 * `GET /api/connections/:id/sync-runs` list. A run's position lives in `cursor` (`RunPosition`);
 * its counts hold numbers, codes, and gateway names only, never a customer's data, a credential,
 * or a bulk result address. The connect job (task 6) still writes its own `connect` runs.
 */
@Injectable()
export class SyncRuns {
  /** Takes the database. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Starts a run in `running` at its first position; answers its id. */
  async start(
    executor: Executor,
    run: {
      connectionId: string;
      kind: SyncRunKind;
      counts?: Record<string, unknown>;
      watermarkFrom?: string | null;
      position?: RunPosition;
    },
  ): Promise<string> {
    const { rows } = await executor.execute<{ id: string }>(sql`
      INSERT INTO connection_sync_runs (connection_id, kind, status, cursor, counts, watermark_from)
      VALUES (${run.connectionId}::uuid, ${run.kind}::sync_run_kind, 'running',
              ${JSON.stringify(run.position ?? firstPosition())},
              ${JSON.stringify(run.counts ?? {})}::jsonb, ${run.watermarkFrom ?? null}::timestamptz)
      RETURNING id`);
    return rows[0]?.id as string;
  }

  /** One run, or null. `forUpdate` locks it for the caller's transaction. */
  async read(
    executor: Executor,
    runId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<SyncRunRow | null> {
    const lock = options.forUpdate ? sql`FOR UPDATE` : sql``;
    const { rows } = await executor.execute<RunRecord>(sql`
      SELECT ${RUN_COLUMNS} FROM connection_sync_runs WHERE id = ${runId}::uuid ${lock}`);
    const row = rows[0];
    return row ? this.rowOf(row) : null;
  }

  /** The newest unfinished run of a connection among `kinds`, or null. */
  async unfinished(
    executor: Executor,
    connectionId: string,
    kinds: readonly SyncRunKind[],
  ): Promise<SyncRunRow | null> {
    const { rows } = await executor.execute<RunRecord>(sql`
      SELECT ${RUN_COLUMNS} FROM connection_sync_runs
      WHERE connection_id = ${connectionId}::uuid AND finished_at IS NULL
        AND kind::text = ANY(${pgArray([...kinds])}::text[])
      ORDER BY started_at DESC, id DESC
      LIMIT 1`);
    const row = rows[0];
    return row ? this.rowOf(row) : null;
  }

  /** The newest `succeeded` run of a kind, or null. */
  async lastSucceeded(
    executor: Executor,
    connectionId: string,
    kind: SyncRunKind,
  ): Promise<SyncRunRow | null> {
    const { rows } = await executor.execute<RunRecord>(sql`
      SELECT ${RUN_COLUMNS} FROM connection_sync_runs
      WHERE connection_id = ${connectionId}::uuid AND kind = ${kind}::sync_run_kind
        AND status = 'succeeded'
      ORDER BY finished_at DESC NULLS LAST, id DESC
      LIMIT 1`);
    const row = rows[0];
    return row ? this.rowOf(row) : null;
  }

  /**
   * Records an unfinished run's progress: its new position, its counts (replaced whole), the cost
   * points spent since the last write, and `partial` once a chunk stopped short of the end.
   */
  async progress(
    executor: Executor,
    runId: string,
    update: {
      position: RunPosition;
      counts: Record<string, unknown>;
      cost: number;
      status: 'running' | 'partial';
    },
  ): Promise<void> {
    await executor.execute(sql`
      UPDATE connection_sync_runs
      SET cursor = ${JSON.stringify(update.position)}, counts = ${JSON.stringify(update.counts)}::jsonb,
          cost_points = cost_points + ${Math.max(0, Math.round(update.cost))},
          status = ${update.status}::sync_run_status
      WHERE id = ${runId}::uuid AND finished_at IS NULL`);
  }

  /** Finishes a run: its status, counts, the cost spent since the last write, and its code. */
  async finish(
    executor: Executor,
    runId: string,
    end: {
      status: 'succeeded' | 'failed';
      counts?: Record<string, unknown>;
      cost?: number;
      errorCode?: string | null;
      watermarkTo?: string | null;
    },
  ): Promise<void> {
    const counts =
      end.counts === undefined ? sql`counts` : sql`${JSON.stringify(end.counts)}::jsonb`;
    await executor.execute(sql`
      UPDATE connection_sync_runs
      SET status = ${end.status}::sync_run_status, finished_at = now(), cursor = NULL,
          counts = ${counts}, cost_points = cost_points + ${Math.max(0, Math.round(end.cost ?? 0))},
          error_code = ${end.errorCode ?? null},
          watermark_to = coalesce(${end.watermarkTo ?? null}::timestamptz, watermark_to)
      WHERE id = ${runId}::uuid AND finished_at IS NULL`);
  }

  /**
   * `GET /api/connections/:id/sync-runs`: one page of a connection's runs, newest first, keyed on
   * (started at, id), optionally of one kind. Throws `NOT_FOUND` for an unknown connection and
   * `INVALID_CURSOR` for a cursor this route did not issue.
   */
  async list(connectionId: string, query: SyncRunListQuery): Promise<SyncRunListResponse> {
    let after: { at: string; id: string } | undefined;
    try {
      after = query.cursor === undefined ? undefined : decodeTimeIdKeyset(query.cursor);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new ConnectionsError('INVALID_CURSOR', 'The cursor is not one this endpoint issued');
      }
      throw error;
    }
    const known = await this.connection.db.execute<{ id: string }>(sql`
      SELECT id FROM connections WHERE id = ${connectionId}::uuid`);
    if (!known.rows[0]) throw new ConnectionsError('NOT_FOUND', 'No connection has that id');
    const kind = query.kind === undefined ? sql`` : sql`AND kind = ${query.kind}::sync_run_kind`;
    const page = after
      ? sql`AND (started_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)`
      : sql``;
    const { rows } = await this.connection.db.execute<RunRecord>(sql`
      SELECT ${RUN_COLUMNS} FROM connection_sync_runs
      WHERE connection_id = ${connectionId}::uuid ${kind} ${page}
      ORDER BY started_at DESC, id DESC
      LIMIT ${query.limit + 1}`);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) =>
        SyncRunView.parse({
          id: row.id,
          kind: row.kind,
          status: row.status,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          watermarkFrom: row.watermark_from,
          watermarkTo: row.watermark_to,
          counts: answerableCounts(countsOf(row.counts)),
          costPoints: row.cost_points,
          errorCode: row.error_code,
        }),
      ),
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.started_at, last.id]) : null,
    };
  }

  private rowOf(row: RunRecord): SyncRunRow {
    return {
      id: row.id,
      connectionId: row.connection_id,
      kind: row.kind,
      status: row.status,
      startedAt: row.started_at,
      finished: row.finished_at !== null,
      watermarkFrom: row.watermark_from,
      position: positionOf(row.cursor),
      counts: countsOf(row.counts),
    };
  }
}
