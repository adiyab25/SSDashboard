import { HomeIcon, PaletteIcon, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '@/i18n/t';

/** Sidebar and palette groups. Each feature that ships pages adds its own. */
export type NavGroup = 'general';

export interface NavItem {
  id: string;
  labelKey: MessageKey;
  href: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Shown only in development builds. */
  devOnly?: true;
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
];

export const navGroups: readonly { id: NavGroup; labelKey: MessageKey }[] = [
  { id: 'general', labelKey: 'shell.nav.groups.general' },
];

/** The entries this build shows: development only pages are dropped in production. */
export function visibleNavItems(): NavItem[] {
  const production = process.env.NODE_ENV === 'production';
  return navItems.filter((item) => !(item.devOnly && production));
}

/** Exact match for `/`; for other pages the page itself or anything below it. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
