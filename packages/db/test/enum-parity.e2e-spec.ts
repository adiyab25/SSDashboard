import {
  CashState,
  ConnectionHealth,
  CostBasis,
  CreditActorType,
  CreditEntryKind,
  CreditFunding,
  ExternalEntity,
  FulfillmentState,
  InboundSource,
  InboundStatus,
  InboundSubject,
  LedgerSourceType,
  LocationOwnerType,
  OrderActorType,
  OrderCostRuleKind,
  OrderCostRuleStatus,
  OrderLineState,
  OrderMachine,
  OrderOutcome,
  OrderPaymentMethod,
  OutboundLinkedType,
  PayoutMethod,
  PhoneKind,
  RefusedReasonCode,
  ReservationStatus,
  SettlementLineKind,
  SettlementMatchedByType,
  SettlementMatchResult,
  SettlementOwnerType,
  SettlementPeriodAction,
  SettlementPeriodActorType,
  SettlementPeriodState,
  SettlementStatementKind,
  StockReceiptStatus,
  SyncRunKind,
  SyncRunStatus,
  TaskCreatedByType,
  TaskLinkedType,
  TaskStatus,
} from '@ssdashboard/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Review m5 (data model milestone 3): a database enum and its Zod twin in @ssdashboard/contracts
// must hold the same values in the same order, or a state the rules accept is refused by the
// database (or the reverse). Run against the migrated baseline, never against the Drizzle source.
// Review R4 (feature 4 close) added the ledger, cost, location, reservation, and receipt twins.
describe('every database enum with a Zod twin matches its contract', () => {
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
    ['order_payment_method', OrderPaymentMethod.options],
    ['credit_entry_kind', CreditEntryKind.options],
    ['credit_funding', CreditFunding.options],
    ['credit_payout_method', PayoutMethod.options],
    ['credit_actor_type', CreditActorType.options],
    ['settlement_owner_type', SettlementOwnerType.options],
    ['settlement_statement_kind', SettlementStatementKind.options],
    ['settlement_line_kind', SettlementLineKind.options],
    ['settlement_match_result', SettlementMatchResult.options],
    ['settlement_matched_by_type', SettlementMatchedByType.options],
    ['settlement_period_status', SettlementPeriodState.options],
    ['settlement_period_action', SettlementPeriodAction.options],
    ['settlement_period_actor_type', SettlementPeriodActorType.options],
    ['task_status', TaskStatus.options],
    ['task_linked_type', TaskLinkedType.options],
    ['task_created_by_type', TaskCreatedByType.options],
    ['order_cost_rule_kind', OrderCostRuleKind.options],
    ['order_cost_rule_status', OrderCostRuleStatus.options],
    ['movement_source_type', LedgerSourceType.options],
    ['cost_basis', CostBasis.options],
    ['location_owner_type', LocationOwnerType.options],
    ['reservation_status', ReservationStatus.options],
    ['stock_receipt_status', StockReceiptStatus.options],
    ['connection_health', ConnectionHealth.options],
    ['outbound_linked_type', OutboundLinkedType.options],
    ['inbound_source', InboundSource.options],
    ['inbound_subject', InboundSubject.options],
    ['inbound_status', InboundStatus.options],
    ['external_entity', ExternalEntity.options],
    ['sync_run_kind', SyncRunKind.options],
    ['sync_run_status', SyncRunStatus.options],
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
