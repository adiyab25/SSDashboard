import { HAT_PERMISSIONS, Permission, permissionsFor, type Hat } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { ANY_HAT, navItems, visibleNavItems } from './nav';

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

  it('shows Audit trail to a manager only (audit.read)', () => {
    expect(ids(['manager'])).toContain('audit');
    expect(ids(['support', 'operations', 'warehouse'])).not.toContain('audit');
    expect(ids()).not.toContain('audit');
  });
});
