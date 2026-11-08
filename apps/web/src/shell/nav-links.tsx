'use client';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@ssdashboard/ui/components/sidebar';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { navGroups, navItemFor, type NavItem } from './nav';

/** Props of `NavLinks`. */
interface NavLinksProps {
  items: NavItem[];
  /** Null while prerendering, so no entry is marked current. */
  pathname: string | null;
}

/**
 * The grouped sidebar links; marks the one entry whose page `pathname` is as the current page (the
 * longest matching address, so `/settings/cost-rules` marks Cost rules, not Settings too).
 */
export function NavLinks({ items, pathname }: NavLinksProps) {
  const { t } = useTranslation();
  const current = pathname === null ? undefined : navItemFor(pathname);
  return navGroups.map((group) => {
    const groupItems = items.filter((item) => item.group === group.id);
    if (groupItems.length === 0) return null;
    return (
      <SidebarGroup key={group.id}>
        <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
        <SidebarMenu>
          {groupItems.map((item) => {
            const active = current?.id === item.id;
            const label = t(item.labelKey);
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={label}
                  className="coarse:h-touch coarse:group-data-[collapsible=icon]:size-touch!"
                >
                  <Link href={item.href} aria-current={active ? 'page' : undefined}>
                    <item.icon aria-hidden />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroup>
    );
  });
}
