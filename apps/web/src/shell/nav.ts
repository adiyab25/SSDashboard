import type { Permission } from '@ssdashboard/contracts';
import {
  BoxesIcon,
  HomeIcon,
  MapPinIcon,
  PackagePlusIcon,
  PaletteIcon,
  TagIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '@ssdashboard/i18n';

/** Sidebar and palette groups. Each feature that ships pages adds its own. */
export type NavGroup = 'general' | 'inventory';

/** One sidebar and palette entry. */
export interface NavItem {
  id: string;
  labelKey: MessageKey;
  href: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Shown only in development builds. */
  devOnly?: true;
  /**
   * The permission a person needs to see the entry (spec 0008, AC-11), the one its page's main
   * route declares; `ANY_HAT` for a page every signed in person may open, as `@AnyHat()` on the
   * api. Required on every entry: `nav.spec.ts` fails an entry without it. The api enforces it too.
   */
  needs: Permission | typeof ANY_HAT;
}

/** The `needs` of a page open to every signed in person, whatever their hats. */
export const ANY_HAT = 'anyHat';

/** Built pages only. Feature 46 later filters this by module toggle too. */
export const navItems: readonly NavItem[] = [
  {
    id: 'home',
    labelKey: 'shell.nav.items.home',
    href: '/',
    icon: HomeIcon,
    group: 'general',
    needs: ANY_HAT,
  },
  {
    id: 'design',
    labelKey: 'shell.nav.items.design',
    href: '/design',
    icon: PaletteIcon,
    group: 'general',
    devOnly: true,
    needs: ANY_HAT,
  },
  {
    id: 'staff',
    labelKey: 'shell.nav.items.staff',
    href: '/staff',
    icon: UsersIcon,
    group: 'general',
    needs: 'people.manage',
  },
  {
    id: 'stock',
    labelKey: 'shell.nav.items.stock',
    href: '/stock',
    icon: BoxesIcon,
    group: 'inventory',
    needs: 'stock.view',
  },
  {
    id: 'receipts',
    labelKey: 'shell.nav.items.receipts',
    href: '/stock-receipts',
    icon: PackagePlusIcon,
    group: 'inventory',
    needs: 'stock.view',
  },
  {
    id: 'skus',
    labelKey: 'shell.nav.items.skus',
    href: '/skus',
    icon: TagIcon,
    group: 'inventory',
    needs: 'stock.view',
  },
  {
    id: 'locations',
    labelKey: 'shell.nav.items.locations',
    href: '/locations',
    icon: MapPinIcon,
    group: 'inventory',
    needs: 'catalog.manage',
  },
];

/** The groups in display order, with their heading keys. */
export const navGroups: readonly { id: NavGroup; labelKey: MessageKey }[] = [
  { id: 'general', labelKey: 'shell.nav.groups.general' },
  { id: 'inventory', labelKey: 'shell.nav.groups.inventory' },
];

/**
 * The entries this build shows to a person with these permissions: development only pages are
 * dropped in production, and an entry whose `needs` the person lacks is dropped (spec 0008,
 * AC-11). While the permissions are unknown only `ANY_HAT` entries show, so nothing flashes in
 * and out. It only hides: the api still answers 403.
 */
export function visibleNavItems(permissions?: readonly Permission[]): NavItem[] {
  const production = process.env.NODE_ENV === 'production';
  const held = new Set<string>(permissions ?? []);
  return navItems.filter(
    (item) => !(item.devOnly && production) && (item.needs === ANY_HAT || held.has(item.needs)),
  );
}

/** Exact match for `/`; for other pages the page itself or anything below it. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
