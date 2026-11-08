import { Inject, Injectable } from '@nestjs/common';
import type { OutboundLinkedType } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import type { Executor } from '../database/sql.js';

/** The command kinds whose availability the orders module asks before an in app edit or cancel. */
export type WriteBackKind = 'shopify.order_edit' | 'shopify.order_cancel';

/** One `waiting` or `failed` outbound command: ids and codes only, never its payload. */
export interface OpenCommand {
  id: string;
  connectionId: string;
  /** The command kind, for example `shopify.order_edit`. */
  kind: string;
  syncState: 'waiting' | 'failed';
  /** A provider error code only (`STEP_OFF`), never provider text; null while waiting. */
  failureReason: string | null;
  /** When the command was written, UTC with microseconds. */
  queuedAt: string;
}

interface OpenCommandRow extends Record<string, unknown> {
  id: string;
  connection_id: string;
  kind: string;
  sync_state: 'waiting' | 'failed';
  failure_reason: string | null;
  queued_at: string;
}

/**
 * The connectors module's exported service, as far as spec 0013 milestone 2 needs it: the reads
 * of `outbound_commands` the orders module asks (`openCommandsFor`, `syncStateFor`) and
 * `writeBackAvailable`. A stand-in until spec 0015 task 13 builds the outbound framework
 * (`enqueue`, executors, retry and resolve): it never writes a command, never reads a command's
 * payload (it may hold an address), and never logs one.
 */
@Injectable()
export class ConnectorsService {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * The `waiting` and `failed` commands of one record, oldest first (spec 0015 AC-24), read in
   * the caller's transaction so a command written earlier in it counts. The `packed` move refuses
   * while this is not empty (spec 0013 AC-7), and the orders write back projection derives
   * `orders.write_back_state` from it (AC-12). Served by `outbound_commands_open_linked_idx`.
   */
  async openCommandsFor(
    linkedType: OutboundLinkedType,
    linkedId: string,
    tx: Executor,
  ): Promise<OpenCommand[]> {
    const { rows } = await tx.execute<OpenCommandRow>(sql`
      SELECT id, connection_id, kind, sync_state, failure_reason,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS queued_at
      FROM outbound_commands
      WHERE linked_type = ${linkedType}::outbound_linked_type AND linked_id = ${linkedId}::uuid
        AND sync_state IN ('waiting', 'failed')
      ORDER BY created_at, id`);
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      kind: row.kind,
      syncState: row.sync_state,
      failureReason: row.failure_reason,
      queuedAt: row.queued_at,
    }));
  }

  /**
   * Where each open command of a record stands, for the order page's command block (spec 0013
   * AC-5, Value sourcing): the same rows as `openCommandsFor`. Pass a transaction to read what it
   * wrote.
   */
  syncStateFor(
    linkedType: OutboundLinkedType,
    linkedId: string,
    executor: Executor = this.connection.db,
  ): Promise<OpenCommand[]> {
    return this.openCommandsFor(linkedType, linkedId, executor);
  }

  /**
   * Whether an order may be edited or cancelled in the app because the change can be written back
   * to its Shopify store (spec 0015 AC-24, spec 0013 AC-7 and AC-10). Always false today: spec
   * 0015 AC-24 makes it true only when the kind's executor is registered, and no executor
   * registers before feature 18, so staff edit and cancel a Shopify order in Shopify and the
   * change syncs back. Spec 0015 task 13 replaces this with the connection, step, and executor
   * checks; it must never answer true without a registered executor.
   */
  writeBackAvailable(_orderId: string, _kind: WriteBackKind): Promise<boolean> {
    return Promise.resolve(false);
  }
}
