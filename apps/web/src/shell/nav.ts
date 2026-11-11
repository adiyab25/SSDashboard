import type { ModuleStateView, Permission } from '@ssdashboard/contracts';
import {
  BoxesIcon,
  CalendarRangeIcon,
  CoinsIcon,
  GitMergeIcon,
  HomeIcon,
  LayersIcon,
  MapPinIcon,
  PackagePlusIcon,
  PaletteIcon,
  PlugZapIcon,
  ScrollTextIcon,
  ShirtIcon,
  SettingsIcon,
  ShoppingBagIcon,
  TagIcon,
  UsersIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '@ssdashboard/i18n';

/** Sidebar and palette groups. Each feature that ships pages adds its own. */
export type NavGroup = 'general' | 'orders' | 'inventory' | 'customers';

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
  /**
   * The module key, or the capability key, whose state governs the page (spec 0009, AC-9): the
   * entry is hidden while it is `off`. Required on every entry: `nav.spec.ts` fails an entry
   * without it, or one naming a key the module registry does not have.
   */
  module: string;
  /**
   * True for an entry that starts work (new, approve, queue): hidden while its module or capability
   * is `read_only` too, where a history page stays and says it is read only (AC-9).
   */
  action?: true;
}

/** The `needs` of a page open to every signed in person, whatever their hats. */
export const ANY_HAT = 'anyHat';

/** Built pages only. Each entry names its module or capability; `visibleNavItems` filters by it. */
export const navItems: readonly NavItem[] = [
  {
    id: 'home',
    labelKey: 'shell.nav.items.home',
    href: '/',
    icon: HomeIcon,
    group: 'general',
    needs: ANY_HAT,
    module: 'platform',
  },
  {
    id: 'design',
    labelKey: 'shell.nav.items.design',
    href: '/design',
    icon: PaletteIcon,
    group: 'general',
    devOnly: true,
    needs: ANY_HAT,
    module: 'platform',
  },
  {
    id: 'staff',
    labelKey: 'shell.nav.items.staff',
    href: '/staff',
    icon: UsersIcon,
    group: 'general',
    needs: 'people.manage',
    module: 'identity',
  },
  {
    id: 'audit',
    labelKey: 'shell.nav.items.audit',
    href: '/audit',
    icon: ScrollTextIcon,
    group: 'general',
    needs: 'audit.read',
    module: 'audit',
  },
  {
    id: 'settings',
    labelKey: 'shell.nav.items.settings',
    href: '/settings',
    icon: SettingsIcon,
    group: 'general',
    needs: 'settings.manage',
    module: 'platform',
  },
  {
    id: 'connections',
    labelKey: 'shell.nav.items.connections',
    href: '/connections',
    icon: PlugZapIcon,
    group: 'general',
    needs: 'settings.manage',
    module: 'connectors',
  },
  {
    id: 'costRules',
    labelKey: 'shell.nav.items.costRules',
    href: '/settings/cost-rules',
    icon: CoinsIcon,
    group: 'general',
    needs: 'cost.view',
    module: 'platform',
  },
  {
    id: 'orders',
    labelKey: 'shell.nav.items.orders',
    href: '/orders',
    icon: ShoppingBagIcon,
    group: 'orders',
    needs: 'orders.view',
    module: 'orders',
  },
  {
    id: 'stock',
    labelKey: 'shell.nav.items.stock',
    href: '/stock',
    icon: BoxesIcon,
    group: 'inventory',
    needs: 'stock.view',
    module: 'inventory',
  },
  {
    id: 'receipts',
    labelKey: 'shell.nav.items.receipts',
    href: '/stock-receipts',
    icon: PackagePlusIcon,
    group: 'inventory',
    needs: 'stock.view',
    module: 'inventory',
  },
  {
    id: 'skus',
    labelKey: 'shell.nav.items.skus',
    href: '/skus',
    icon: TagIcon,
    group: 'inventory',
    needs: 'stock.view',
    module: 'catalog',
  },
  {
    id: 'styles',
    labelKey: 'shell.nav.items.styles',
    href: '/styles',
    icon: ShirtIcon,
    group: 'inventory',
    needs: 'stock.view',
    module: 'catalog',
  },
  {
    id: 'seasons',
    labelKey: 'shell.nav.items.seasons',
    href: '/seasons',
    icon: CalendarRangeIcon,
    group: 'inventory',
    needs: 'catalog.manage',
    module: 'catalog',
  },
  {
    id: 'productGroups',
    labelKey: 'shell.nav.items.productGroups',
    href: '/product-groups',
    icon: LayersIcon,
    group: 'inventory',
    needs: 'catalog.manage',
    module: 'catalog',
  },
  {
    id: 'locations',
    labelKey: 'shell.nav.items.locations',
    href: '/locations',
    icon: MapPinIcon,
    group: 'inventory',
    needs: 'catalog.manage',
    module: 'inventory',
  },
  {
    id: 'customers',
    labelKey: 'shell.nav.items.customers',
    href: '/customers',
    icon: UsersRoundIcon,
    group: 'customers',
    needs: 'customers.view',
    module: 'customers',
  },
  {
    id: 'customersMerge',
    labelKey: 'shell.nav.items.customersMerge',
    href: '/customers/merge',
    icon: GitMergeIcon,
    group: 'customers',
    needs: 'customers.merge',
    module: 'customers',
    action: true,
  },
];

/** The groups in display order, with their heading keys. */
export const navGroups: readonly { id: NavGroup; labelKey: MessageKey }[] = [
  { id: 'general', labelKey: 'shell.nav.groups.general' },
  { id: 'orders', labelKey: 'shell.nav.groups.orders' },
  { id: 'inventory', labelKey: 'shell.nav.groups.inventory' },
  { id: 'customers', labelKey: 'shell.nav.groups.customers' },
];

/** What `visibleNavItems` needs to know of the module states: one state per key, null when unknown. */
export type NavModuleStates = (key: string) => ModuleStateView | null;

/**
 * The entries this build shows to a person with these permissions: development only pages are
 * dropped in production, an entry whose `needs` the person lacks is dropped (spec 0008, AC-11),
 * an entry whose module or capability is `off` is dropped, and an action entry whose one is
 * `read_only` is dropped too (spec 0009, AC-9). While the permissions are unknown only `ANY_HAT`
 * entries show, so nothing flashes in and out; while the module states are unknown (`stateOf`
 * absent, or null for the key) the entry shows. It only hides: the api still answers 403 and 404.
 */
export function visibleNavItems(
  permissions?: readonly Permission[],
  stateOf?: NavModuleStates,
): NavItem[] {
  const production = process.env.NODE_ENV === 'production';
  const held = new Set<string>(permissions ?? []);
  return navItems.filter((item) => {
    if (item.devOnly && production) return false;
    if (item.needs !== ANY_HAT && !held.has(item.needs)) return false;
    const state = stateOf?.(item.module)?.state;
    if (state === 'off') return false;
    return !(state === 'read_only' && item.action);
  });
}

/** The entry whose page `pathname` is (the longest matching address), or undefined. */
export function navItemFor(pathname: string): NavItem | undefined {
  return navItems
    .filter((item) => isActive(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/** Exact match for `/`; for other pages the page itself or anything below it. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
