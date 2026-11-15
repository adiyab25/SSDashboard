import { describe, expect, it } from 'vitest';
import { InternalHat, permissionsFor, type Permission } from '@ssdashboard/contracts';
import { visibilityPlan, type VisibilityCaller } from './task-visibility.js';

const ME = '00000000-0000-7000-8000-000000000001';
const OTHER = '00000000-0000-7000-8000-000000000002';

function caller(hats: InternalHat[]): VisibilityCaller {
  const held = new Set<Permission>(permissionsFor(hats, []));
  return { userId: ME, hats, has: (permission) => held.has(permission) };
}

const holders = (entries: Partial<Record<InternalHat, string[]>>) =>
  new Map<InternalHat, readonly string[]>(
    InternalHat.options.map((hat) => [hat, entries[hat] ?? []]),
  );

describe('visibilityPlan (spec 0016 AC-5)', () => {
  it('shows a support agent the write back type and her hat queue only', () => {
    const plan = visibilityPlan(
      caller(['support']),
      holders({ support: [ME], operations: [OTHER] }),
    );

    expect(plan.visibleTypes).toEqual(['sync.write_back_failed']);
    expect(plan.hats).toEqual(['support']);
    expect(plan.orphanHats).toEqual([]);
    expect(plan.fallback).toEqual([{ types: ['sync.write_back_failed'], eligible: [ME, OTHER] }]);
  });

  it('shows a warehouse person no type: none of them needs her permissions', () => {
    const plan = visibilityPlan(caller(['warehouse']), holders({ warehouse: [ME] }));

    expect(plan.visibleTypes).toEqual([]);
  });

  it('gives a manager the queues of hats nobody active wears', () => {
    const plan = visibilityPlan(caller(['manager']), holders({ manager: [ME] }));

    expect(plan.orphanHats).toEqual(['support', 'operations', 'warehouse']);
  });

  it('keeps a manager out of a hat that has a holder', () => {
    const plan = visibilityPlan(
      caller(['manager']),
      holders({ manager: [ME], operations: [OTHER], support: [OTHER], warehouse: [OTHER] }),
    );

    expect(plan.orphanHats).toEqual([]);
  });

  it('never gives orphan queues to a person who is not a manager', () => {
    expect(
      visibilityPlan(caller(['operations']), holders({ operations: [ME] })).orphanHats,
    ).toEqual([]);
  });
});
