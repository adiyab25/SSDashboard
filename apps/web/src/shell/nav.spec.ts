import {
  HAT_PERMISSIONS,
  MODULE_REGISTRY,
  Permission,
  permissionsFor,
  type Hat,
  type ModuleStateView,
} from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { ANY_HAT, navItemFor, navItems, visibleNavItems, type NavItem } from './nav';
import { stateView } from './module-fixtures';

const ids = (hats?: readonly Hat[], grants: readonly Permission[] = []) =>
  visibleNavItems(hats === undefined ? undefined : permissionsFor(hats, grants)).map(
    (item) => item.id,
  );

describe('nav item needs (spec 0008, AC-11)', () => {
  it.each(navItems.map((item) => [item.id, item] as const))(
    '%s declares the permission it needs',
    (_id, item) => {
      // A nav item without `needs` would show to everyone: the registry refuses it.
      expect(Object.hasOwn(item, 'needs')).toBe(true);
      expect(item.needs === ANY_HAT || Permission.safeParse(item.needs).success).toBe(true);
    },
  );

  it('keeps ANY_HAT to the pages every signed in person may open', () => {
    expect(navItems.filter((item) => item.needs === ANY_HAT).map((item) => item.id)).toEqual([
      'home',
      'design',
    ]);
  });
});

describe('visibleNavItems (spec 0008, AC-11)', () => {
  it('shows Staff to a manager only, through people.manage', () => {
    expect(ids(['manager'])).toContain('staff');
    for (const hat of ['support', 'operations', 'warehouse', 'media_buyer'] as const) {
      expect(ids([hat])).not.toContain('staff');
    }
  });

  it('shows Locations to catalog.manage only, and the stock pages to stock.view', () => {
    expect(ids(['manager'])).toContain('locations');
    expect(ids(['warehouse'])).not.toContain('locations');
    expect(ids(['warehouse'])).toEqual(expect.arrayContaining(['stock', 'receipts', 'skus']));
  });

  it('shows Customers to customers.view holders only (spec 0014, AC-18)', () => {
    for (const hat of ['support', 'operations', 'manager'] as const) {
      expect(ids([hat])).toContain('customers');
    }
    for (const hat of ['warehouse', 'media_buyer'] as const) {
      expect(ids([hat])).not.toContain('customers');
    }
  });

  it('shows a media buyer only the pages open to every hat', () => {
    expect(HAT_PERMISSIONS.media_buyer).not.toContain('stock.view');
    expect(ids(['media_buyer'])).toEqual(['home', 'design']);
  });

  it('shows only the pages open to every hat while the permissions are unknown', () => {
    expect(ids()).toEqual(['home', 'design']);
  });

  it('follows the union of every hat a person wears', () => {
    expect(ids(['support', 'manager'])).toEqual(ids(['manager']));
  });

  it('shows Settings to a manager only (settings.manage)', () => {
    expect(ids(['manager'])).toContain('settings');
    expect(ids(['support', 'operations', 'warehouse'])).not.toContain('settings');
    expect(ids()).not.toContain('settings');
  });

  it('shows Cost rules to whoever holds the cost grant, settings or not (spec 0009, AC-25, D15)', () => {
    expect(ids(['support'], ['cost.view'])).toContain('costRules');
    expect(ids(['support'], ['cost.view'])).not.toContain('settings');
    expect(ids(['manager'])).not.toContain('costRules');
    expect(ids(['manager'], ['cost.view'])).toContain('costRules');
  });

  it('shows Audit trail to a manager only (audit.read)', () => {
    expect(ids(['manager'])).toContain('audit');
    expect(ids(['support', 'operations', 'warehouse'])).not.toContain('audit');
    expect(ids()).not.toContain('audit');
  });
});

describe('nav item modules (spec 0009, AC-9)', () => {
  const keys = new Set(
    MODULE_REGISTRY.flatMap((module) => [
      module.key,
      ...module.capabilities.map((capability) => capability.key),
    ]),
  );

  it.each(navItems.map((item) => [item.id, item] as const))(
    '%s names a module or capability the registry has',
    (_id, item) => {
      expect(keys.has(item.module)).toBe(true);
    },
  );

  const manager = permissionsFor(['manager'], []);
  const stateOf =
    (state: 'off' | 'read_only' | 'limited' | 'on', key: string) =>
    (asked: string): ModuleStateView | null =>
      asked === key ? stateView({ key, state, reason: 'toggled_off' }) : null;
  const shown = (states?: (key: string) => ModuleStateView | null) =>
    visibleNavItems(manager, states).map((item) => item.id);

  it('hides every entry of an off module and keeps the others', () => {
    const ids = shown(stateOf('off', 'inventory'));
    expect(ids).not.toContain('stock');
    expect(ids).not.toContain('receipts');
    expect(ids).not.toContain('locations');
    expect(ids).toEqual(expect.arrayContaining(['home', 'staff', 'skus', 'settings']));
  });

  it('shows entries of a read only or limited module, and of one whose state is unknown', () => {
    expect(shown(stateOf('read_only', 'inventory'))).toContain('stock');
    expect(shown(stateOf('limited', 'inventory'))).toContain('stock');
    expect(shown(stateOf('on', 'inventory'))).toContain('stock');
    expect(shown(() => null)).toContain('stock');
    expect(shown()).toContain('stock');
  });

  it('hides an action entry while read only, and keeps it while limited', () => {
    const list = navItems as NavItem[];
    list.push({
      ...(navItems[0] as NavItem),
      id: 'fixture-action',
      module: 'fixture',
      action: true,
    });
    try {
      expect(shown(stateOf('read_only', 'fixture'))).not.toContain('fixture-action');
      expect(shown(stateOf('limited', 'fixture'))).toContain('fixture-action');
    } finally {
      list.pop();
    }
  });

  it('finds the entry of an address, the longest match first', () => {
    expect(navItemFor('/stock-receipts')?.id).toBe('receipts');
    expect(navItemFor('/skus/abc')?.id).toBe('skus');
    expect(navItemFor('/')?.id).toBe('home');
    expect(navItemFor('/nowhere')).toBeUndefined();
    expect(navItemFor('/settings/cost-rules')?.id).toBe('costRules');
    expect(navItemFor('/settings')?.id).toBe('settings');
  });
});
