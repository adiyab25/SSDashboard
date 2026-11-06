import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index.js';
import { schemaTables, TABLE_OWNERSHIP } from './table-ownership.js';

// Spec 0002, A5 (AC-34): every table the Drizzle schema defines has an owning module in the map.

/** The SQL names of the given tables that the ownership map does not list. */
function missingFromMap(exports: Record<string, unknown>): string[] {
  return schemaTables(exports)
    .map((table) => table.sqlName)
    .filter((name) => !Object.hasOwn(TABLE_OWNERSHIP, name));
}

describe('table ownership map (spec 0002, A5)', () => {
  it('reads the tables, by export and SQL name, from the schema', () => {
    const tables = schemaTables();

    expect(tables).toContainEqual({ exportName: 'orders', sqlName: 'orders' });
    expect(tables).toContainEqual({ exportName: 'creditEntries', sqlName: 'credit_entries' });
    expect(tables).toContainEqual({ exportName: 'orderCostRules', sqlName: 'order_cost_rules' });
    expect(tables.map((table) => table.exportName)).not.toContain('orderType');
    expect(tables.length).toBeGreaterThan(50);
  });

  it('names an owner for every table in the schema', () => {
    expect(missingFromMap(schema)).toEqual([]);
  });

  it('fails for a planted table that is missing from the map', () => {
    const planted = pgTable('planted_without_owner', { id: uuid('id').primaryKey() });

    expect(missingFromMap({ ...schema, planted })).toEqual(['planted_without_owner']);
  });

  it('lists the tables later features build, so they land in a known module', () => {
    expect(TABLE_OWNERSHIP).toMatchObject({
      hat_assignments: 'identity',
      permission_grants: 'identity',
      licenses: 'platform',
      license_checks: 'platform',
      audit_entries: 'audit',
      refunds: 'credit',
      shipments: 'orders',
      channel_codes: 'channels',
      inbound_events: 'connectors',
      connection_external_ids: 'connectors',
      exchanges: 'exchanges',
      export_runs: 'exports',
    });
  });
});
