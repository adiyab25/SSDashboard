import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAccess } from './use-access';

const me = vi.hoisted(
  (): {
    current: { hats: string[]; permissions: string[] } | null;
    path: string | undefined;
  } => ({ current: null, path: undefined }),
);
vi.mock('@/auth/use-me', () => ({
  useMe: (path?: string) => {
    me.path = path;
    return me.current;
  },
}));

afterEach(() => {
  me.current = null;
  me.path = undefined;
});

describe('useAccess (spec 0008, AC-11)', () => {
  it('can nothing and is not ready while the who am I answer is loading', () => {
    const { result } = renderHook(() => useAccess());

    expect(result.current.ready).toBe(false);
    expect(result.current.hats).toEqual([]);
    expect(result.current.permissions).toEqual([]);
    expect(result.current.can('stock.view')).toBe(false);
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
