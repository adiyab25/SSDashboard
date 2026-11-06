import {
  CashState,
  FulfillmentState,
  OrderActorType,
  OrderLineState,
  OrderMachine,
  OrderOutcome,
  PhoneKind,
  RefusedReasonCode,
} from '@ssdashboard/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Review m5 (data model milestone 3): a database enum and its Zod twin in @ssdashboard/contracts
// must hold the same values in the same order, or a state the rules accept is refused by the
// database (or the reverse). Run against the migrated baseline, never against the Drizzle source.
describe('order and customer enums match their contracts', () => {
  let name: string;
  let owner: pg.Client;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
  });

  it.each([
    ['order_fulfillment_state', FulfillmentState.options],
    ['order_cash_state', CashState.options],
    ['order_outcome', OrderOutcome.options],
    ['order_line_state', OrderLineState.options],
    ['order_actor_type', OrderActorType.options],
    ['order_machine', OrderMachine.options],
    ['customer_phone_kind', PhoneKind.options],
  ] as const)('%s has the values of its Zod enum', async (type, options) => {
    const { rows } = await owner.query<{ value: string }>(
      `SELECT unnest(enum_range(NULL::public.${type}))::text AS value`,
    );

    expect(rows.map((row) => row.value)).toEqual([...options]);
  });

  it('accepts exactly the refusal reasons of RefusedReasonCode', async () => {
    const { rows } = await owner.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'orders_refused_reason_known'",
    );
    const definition = rows[0]?.definition ?? '';
    const listed = [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);

    expect(listed).toEqual([...RefusedReasonCode.options]);
  });
});
