import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.js';

/**
 * The api modules that own tables (spec 0002, tenancy child, A5). `identity` is today's `auth` and
 * `staff` folders, which move into `apps/api/src/identity/` with feature 7.
 */
export type OwningModule =
  | 'platform'
  | 'audit'
  | 'identity'
  | 'catalog'
  | 'inventory'
  | 'customers'
  | 'orders'
  | 'tasks'
  | 'credit'
  | 'settlement'
  | 'channels'
  | 'connectors'
  | 'partners'
  | 'exchanges'
  | 'exports';

/**
 * Every table, by its SQL name, mapped to the one module that owns it, exactly as the A5 table of
 * spec 0002 (tenancy child) lists it, including the tables later features build (the hat and
 * license tables, `audit_entries`, `refunds`, `shipments`, and the rest), so a new table lands in
 * a known module. Only the owner reads or writes a table; other modules call its exported
 * services or listen to its events, and foreign keys between modules' tables are allowed.
 * `table-ownership.spec.ts` fails when a schema table is missing here, and the api's
 * `module-boundary.spec.ts` reads this map. Never add a table without its owner, and never move
 * one to another module without amending A5.
 */
export const TABLE_OWNERSHIP = {
  install: 'platform',
  settings: 'platform',
  document_counters: 'platform',
  custom_field_definitions: 'platform',
  order_cost_rules: 'platform',
  licenses: 'platform',
  license_checks: 'platform',

  audit_entries: 'audit',

  users: 'identity',
  sessions: 'identity',
  accounts: 'identity',
  verifications: 'identity',
  rate_limits: 'identity',
  sign_in_attempts: 'identity',
  two_factors: 'identity',
  hat_assignments: 'identity',
  permission_grants: 'identity',

  uoms: 'catalog',
  products: 'catalog',
  product_options: 'catalog',
  product_variants: 'catalog',
  variant_uom_conversions: 'catalog',
  barcodes: 'catalog',
  seasons: 'catalog',
  product_groups: 'catalog',
  cost_records: 'catalog',

  locations: 'inventory',
  bins: 'inventory',
  location_owner_policies: 'inventory',
  lots: 'inventory',
  serials: 'inventory',
  movement_groups: 'inventory',
  stock_movements: 'inventory',
  movement_serials: 'inventory',
  stock_levels: 'inventory',
  reservations: 'inventory',
  stock_level_discrepancies: 'inventory',
  stock_receipts: 'inventory',
  stock_receipt_lines: 'inventory',

  customers: 'customers',
  customer_phones: 'customers',
  customer_external_ids: 'customers',
  customer_merges: 'customers',

  orders: 'orders',
  order_lines: 'orders',
  order_events: 'orders',
  shipments: 'orders',

  tasks: 'tasks',

  credit_entries: 'credit',
  refunds: 'credit',

  settlement_accounts: 'settlement',
  settlement_periods: 'settlement',
  settlement_period_events: 'settlement',
  settlement_statements: 'settlement',
  settlement_lines: 'settlement',
  settlement_line_matches: 'settlement',

  stores: 'channels',
  channels: 'channels',
  channel_codes: 'channels',

  connections: 'connectors',
  outbound_commands: 'connectors',
  inbound_events: 'connectors',
  connection_external_ids: 'connectors',

  parties: 'partners',

  exchanges: 'exchanges',

  export_runs: 'exports',
} as const satisfies Record<string, OwningModule>;

/** The SQL name of a table in the ownership map. */
export type OwnedTable = keyof typeof TABLE_OWNERSHIP;

/**
 * The append only tables (spec 0002, tenancy child, A4; security review S7): the one declared list.
 * Each built one must have the `ssd_reject_change` row and truncate triggers and the app role's
 * UPDATE, DELETE, and TRUNCATE revoked in the rules migration, and `test/schema.e2e-spec.ts`
 * fails when this list, the trigger set, and the revoked set differ. Tables later features build
 * (`licenses`, `license_checks`, `audit_entries`) are listed now, so they are checked the day
 * they land. Never take a table off this list: history that could be edited is no history.
 */
export const APPEND_ONLY_TABLES = [
  'movement_groups',
  'stock_movements',
  'movement_serials',
  'stock_receipt_lines',
  'cost_records',
  'order_events',
  'customer_merges',
  'credit_entries',
  'settlement_statements',
  'settlement_lines',
  'settlement_line_matches',
  'settlement_period_events',
  'order_cost_rules',
  'licenses',
  'license_checks',
  'audit_entries',
] as const satisfies readonly OwnedTable[];

/** The SQL name of a table in the append only list. */
export type AppendOnlyTable = (typeof APPEND_ONLY_TABLES)[number];

/** A Drizzle table of the schema: the name it is exported under and its SQL name. */
export interface SchemaTable {
  /** The export name, for example `stockMovements`. */
  exportName: string;
  /** The SQL name, for example `stock_movements`. */
  sqlName: string;
}

/**
 * The Drizzle tables among a set of exports (by default this package's whole schema), read with
 * Drizzle's own `is(value, PgTable)` and `getTableName`, so the ownership checks never keep a
 * second list of tables by hand. Pure: it never touches a database.
 */
export function schemaTables(exports: Record<string, unknown> = schema): SchemaTable[] {
  return Object.entries(exports)
    .filter((entry): entry is [string, PgTable] => is(entry[1], PgTable))
    .map(([exportName, table]) => ({ exportName, sqlName: getTableName(table) }));
}
