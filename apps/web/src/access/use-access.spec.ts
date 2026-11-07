import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAccess } from './use-access';

const me = vi.hoisted(
  (): {
    current: { hats: string[]; permissions: string[] } | null;
    failed: boolean;
    path: string | undefined;
    attempts: number[];
  } => ({ current: null, failed: false, path: undefined, attempts: [] }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: (path?: string, attempt = 0) => {
    me.path = path;
    me.attempts.push(attempt);
    if (me.current) return { status: 'ready', me: me.current };
    return { status: me.failed ? 'failed' : 'loading' };
  },
}));

afterEach(() => {
  me.current = null;
  me.failed = false;
  me.path = undefined;
  me.attempts = [];
});

describe('useAccess (spec 0008, AC-11)', () => {
  it('can nothing and is not ready while the who am I answer is loading', () => {
    const { result } = renderHook(() => useAccess());

    expect(result.current.ready).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(result.current.hats).toEqual([]);
    expect(result.current.permissions).toEqual([]);
    expect(result.current.can('stock.view')).toBe(false);
  });

  it('reports a failed who am I call as failed, not ready, and retry asks again', () => {
    me.failed = true;
    const { result } = renderHook(() => useAccess());

    expect(result.current.failed).toBe(true);
    expect(result.current.ready).toBe(false);
    expect(result.current.can('stock.view')).toBe(false);

    act(() => result.current.retry());

    expect(me.attempts.at(-1)).toBe(1);
  });

  it('answers can from the effective permissions, extra grants included', () => {
    me.current = { hats: ['warehouse'], permissions: ['cost.view', 'stock.receive', 'stock.view'] };
    const { result } = renderHook(() => useAccess());

    expect(result.current.ready).toBe(true);
    expect(result.current.hats).toEqual(['warehouse']);
    expect(result.current.can('stock.view')).toBe(true);
    expect(result.current.can('cost.view')).toBe(true);
    expect(result.current.can('people.manage')).toBe(false);
  });

  it('never derives a permission from a hat name: only the answer counts', () => {
    // The api sends the effective list; a manager without cost.view must not see cost.
    me.current = { hats: ['manager'], permissions: ['people.manage'] };
    const { result } = renderHook(() => useAccess());

    expect(result.current.can('people.manage')).toBe(true);
    expect(result.current.can('cost.view')).toBe(false);
    expect(result.current.can('stock.view')).toBe(false);
  });

  it('reads the who am I route it is given, for the partner pages', () => {
    me.current = { hats: ['partner'], permissions: ['partner.view_own'] };
    const { result } = renderHook(() => useAccess('/api/partner/me'));

    expect(me.path).toBe('/api/partner/me');
    expect(result.current.can('partner.view_own')).toBe(true);
  });

  it('keeps the same answer between renders while the person is unchanged', () => {
    const person = { hats: ['support'], permissions: ['stock.view'] };
    me.current = person;
    const { result, rerender } = renderHook(() => useAccess());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
