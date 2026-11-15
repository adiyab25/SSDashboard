import { describe, expect, it, vi } from 'vitest';
import { TaskLinkResolverTaken, TaskLinks, type TaskLinkResolver } from './task-links.js';

const ID = '00000000-0000-7000-8000-0000000000a1';

const label = { kind: 'order' as const, number: '#1042', storeCode: 'ESS' };

function resolver() {
  const spy = vi.fn((ids: readonly string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, { label, path: `/orders/${id}` }]))),
  );
  const value: TaskLinkResolver = { describe: (ids) => spy(ids) };
  return { value, spy };
}

describe('TaskLinks (spec 0016 AC-12)', () => {
  it('asks the owner for the labels and paths of a kind', async () => {
    const links = new TaskLinks();
    const orders = resolver();
    links.register('order', orders.value, 'orders');

    const found = await links.describe('order', [ID]);

    expect(found.get(ID)).toEqual({
      label,
      path: `/orders/${ID}`,
    });
    expect(orders.spy).toHaveBeenCalledWith([ID]);
  });

  it('shows a kind with no resolver by its kind only, and asks nobody for no ids', async () => {
    const links = new TaskLinks();
    const orders = resolver();
    links.register('order', orders.value, 'orders');

    expect((await links.describe('customer', [ID])).size).toBe(0);
    expect((await links.describe('order', [])).size).toBe(0);
    expect(orders.spy).not.toHaveBeenCalled();
  });

  it('refuses a second resolver for one linked type, naming both owners', () => {
    const links = new TaskLinks();
    links.register('order', resolver().value, 'orders');

    expect(() => links.register('order', resolver().value, 'other')).toThrow(TaskLinkResolverTaken);
    expect(() => links.register('order', resolver().value, 'other')).toThrow(/orders.*other/);
    expect(() => links.register('customer', resolver().value, 'customers')).not.toThrow();
  });
});
