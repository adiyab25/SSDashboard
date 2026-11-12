import { randomUUID } from 'node:crypto';
import type { InProcessApi } from './in-process-api.js';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';

/**
 * Plants a sellable warehouse as the owner (not online) and answers its id. The orders suites use
 * it for the online location and for a candidate location of the online gate.
 */
export async function plantWarehouse(api: InProcessApi): Promise<string> {
  const { rows } = await api.owner.pool.query<{ id: string }>(
    `INSERT INTO locations (code, name, kind, allow_negative, is_sellable)
     VALUES ($1, '{"en": "Orders warehouse"}', 'warehouse', false, true) RETURNING id`,
    [`OWH-${randomUUID().slice(0, 8)}`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('No warehouse planted');
  return id;
}

/** Makes `locationId` the one online location, as the online gate's move would (spec 0011). */
export async function makeOnline(api: InProcessApi, locationId: string): Promise<void> {
  await api.owner.pool.query('UPDATE locations SET sellable_online = false WHERE sellable_online');
  await api.owner.pool.query('UPDATE locations SET sellable_online = true WHERE id = $1', [
    locationId,
  ]);
}

/** Posts an opening balance of `quantity` pieces of each variant at the location, through the ledger. */
export async function putOnShelf(
  api: InProcessApi,
  locationId: string,
  variantIds: readonly string[],
  quantity: number,
): Promise<void> {
  await api.app.get(LedgerService).post({
    idempotencyKey: randomUUID(),
    sourceType: 'opening_balance',
    sourceId: randomUUID(),
    postedBy: null,
    lines: variantIds.map((variantId) => ({
      variantId,
      locationId,
      quantity,
      unitCost: '100.0000',
    })),
  });
}

/**
 * The common setup of an orders suite that packs: an online warehouse with `quantity` pieces of
 * each variant, so a line is never short unless the suite makes it so. Answers the location id.
 */
export async function stockedOnline(
  api: InProcessApi,
  variantIds: readonly string[],
  quantity = 10_000,
): Promise<string> {
  const location = await plantWarehouse(api);
  await makeOnline(api, location);
  if (variantIds.length) await putOnShelf(api, location, variantIds, quantity);
  return location;
}
