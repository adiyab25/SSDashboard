import type { StaffRole } from '@ssdashboard/contracts';
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
import type { MessageKey } from '@/i18n/message-key';

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
  /** Shown only to administrators (spec 0005, AC-25). The api enforces it too. */
  adminOnly?: true;
}

/** Built pages only. Features 13 and 46 later filter this by role and module toggle. */
export const navItems: readonly NavItem[] = [
  { id: 'home', labelKey: 'shell.nav.items.home', href: '/', icon: HomeIcon, group: 'general' },
  {
    id: 'design',
    labelKey: 'shell.nav.items.design',
    href: '/design',
    icon: PaletteIcon,
    group: 'general',
    devOnly: true,
  },
  {
    id: 'staff',
    labelKey: 'shell.nav.items.staff',
    href: '/staff',
    icon: UsersIcon,
    group: 'general',
    adminOnly: true,
  },
  {
    id: 'stock',
    labelKey: 'shell.nav.items.stock',
    href: '/stock',
    icon: BoxesIcon,
    group: 'inventory',
  },
  {
    id: 'receipts',
    labelKey: 'shell.nav.items.receipts',
    href: '/stock-receipts',
    icon: PackagePlusIcon,
    group: 'inventory',
  },
  {
    id: 'skus',
    labelKey: 'shell.nav.items.skus',
    href: '/skus',
    icon: TagIcon,
    group: 'inventory',
  },
  {
    id: 'locations',
    labelKey: 'shell.nav.items.locations',
    href: '/locations',
    icon: MapPinIcon,
    group: 'inventory',
    adminOnly: true,
  },
];

/** The groups in display order, with their heading keys. */
export const navGroups: readonly { id: NavGroup; labelKey: MessageKey }[] = [
  { id: 'general', labelKey: 'shell.nav.groups.general' },
  { id: 'inventory', labelKey: 'shell.nav.groups.inventory' },
];

/**
 * The entries this build shows to this role: development only pages are dropped in production,
 * and admin only pages are shown only to an administrator (none while the role is unknown).
 */
export function visibleNavItems(role?: StaffRole): NavItem[] {
  const production = process.env.NODE_ENV === 'production';
  return navItems.filter(
    (item) => !(item.devOnly && production) && !(item.adminOnly && role !== 'admin'),
  );
}

/** Exact match for `/`; for other pages the page itself or anything below it. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
