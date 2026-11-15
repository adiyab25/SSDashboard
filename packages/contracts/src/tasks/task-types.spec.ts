import { en } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { describe, expect, it } from 'vitest';
import { HAT_PERMISSIONS, PERMISSIONS } from '../access.js';
import { MODULE_REGISTRY } from '../modules/module-registry.js';
import { ReasonCode } from '../orders/order-states.js';
import { TASK_TYPES, taskTypeOf, type TaskTypeDefinition } from './task-types.js';

/** Whether a dotted key is a non empty string in a nested catalog. */
function hasKey(catalog: unknown, key: string): boolean {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.length > 0;
}

describe('TASK_TYPES (spec 0016, AC-1)', () => {
  const entries = Object.entries(TASK_TYPES) as [string, TaskTypeDefinition][];
  const moduleKeys = new Set(MODULE_REGISTRY.map((module) => module.key));

  it('holds the milestone 1 type', () => {
    expect(Object.keys(TASK_TYPES)).toEqual(['sync.write_back_failed']);
    expect(taskTypeOf('sync.write_back_failed')?.closedBy).toBe('system');
    expect(taskTypeOf('nothing.here')).toBeUndefined();
    expect(taskTypeOf('toString')).toBeUndefined();
  });

  it.each(entries)('%s: the code and every outcome are ReasonCode shaped', (code, type) => {
    expect(ReasonCode.safeParse(code).success).toBe(true);
    for (const outcome of type.outcomes) expect(ReasonCode.safeParse(outcome).success).toBe(true);
  });

  it.each(entries)('%s: the module is in MODULE_REGISTRY', (_code, type) => {
    expect(moduleKeys.has(type.module)).toBe(true);
  });

  it.each(entries)('%s: the default hat holds a staff permission', (_code, type) => {
    expect(HAT_PERMISSIONS[type.defaultHat]).toContain(type.requiredPermission);
    expect(PERMISSIONS[type.requiredPermission].audience).toBe('staff');
  });

  it.each(entries)('%s: outcomes are listed and the flagged ones are among them', (_code, type) => {
    expect(type.outcomes.length).toBeGreaterThan(0);
    for (const outcome of [...(type.systemOutcomes ?? []), ...(type.noteRequiredOutcomes ?? [])]) {
      expect(type.outcomes).toContain(outcome);
    }
    // A type only the system closes has nothing a person may set.
    if (type.closedBy === 'system') expect(type.systemOutcomes ?? []).toEqual(type.outcomes);
  });

  it.each(entries)('%s: every label key is in both catalogs', (_code, type) => {
    expect(Object.keys(type.outcomeLabels).sort()).toEqual([...type.outcomes].sort());
    for (const key of [type.label, ...Object.values(type.outcomeLabels)]) {
      expect(hasKey(en, key), `en ${key}`).toBe(true);
      expect(hasKey(ar, key), `ar ${key}`).toBe(true);
    }
  });

  // The check "an order attention kind has no type" belongs to milestone 3, which adds the
  // order.<kind> rows; it is not written until then.
});
