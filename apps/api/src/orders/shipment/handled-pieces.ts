import { sql } from '@ssdashboard/db';
import type { Executor } from '../../database/sql.js';

/** How many posted pieces of one line were already restocked or closed (spec 0013 AC-27 a). */
export interface HandledPieces {
  /** The order line the posting's movement names (a split row counts toward its original). */
  lineId: string;
  quantity: number;
}

/**
 * Reads (under `FOR UPDATE` on the order's line rows when `lock` is set) how many posted pieces of each line of the
 * current generation were already put back on the shelf or closed (`restocked_quantity` plus
 * `closed_quantity`, owner ruling 2026-11-21), keyed by the line a shipment movement names: a
 * split row counts toward the line it was split from. Lines with none are left out. With `lock`
 * the row locks make a restock posting still running on the order wait, so the answer is final
 * for the caller's transaction, which holds the order row lock first. Reads only.
 */
export async function handledQuantitiesOf(
  executor: Executor,
  orderId: string,
  lock: boolean,
): Promise<HandledPieces[]> {
  const { rows } = await executor.execute<{
    id: string;
    split_from_line_id: string | null;
    handled: number;
  }>(sql`
    SELECT id, split_from_line_id, restocked_quantity + closed_quantity AS handled
    FROM order_lines WHERE order_id = ${orderId}::uuid ORDER BY id
    ${lock ? sql`FOR UPDATE` : sql``}`);
  const handled = new Map<string, number>();
  for (const row of rows) {
    if (row.handled <= 0) continue;
    const lineId = (row.split_from_line_id ?? row.id).toLowerCase();
    handled.set(lineId, (handled.get(lineId) ?? 0) + row.handled);
  }
  return [...handled].map(([lineId, quantity]) => ({ lineId, quantity }));
}
