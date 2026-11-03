'use client';

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@ssdashboard/ui/components/sidebar';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { isActive, navGroups, visibleNavItems } from './nav';

/** The navigation registry grouped by module; an icon rail when collapsed, a sheet on phones. */
export function AppSidebar() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const items = visibleNavItems();

  // The phone sheet closes once a page is picked.
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return (
    <Sidebar collapsible="icon" mobileLabel={t('shell.sidebar.mobileLabel')}>
      <SidebarContent>
        <nav aria-label={t('shell.nav.label')}>
          {navGroups.map((group) => {
            const groupItems = items.filter((item) => item.group === group.id);
            if (groupItems.length === 0) return null;
            return (
              <SidebarGroup key={group.id}>
                <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
                <SidebarMenu>
                  {groupItems.map((item) => {
                    const active = isActive(pathname, item.href);
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
          })}
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}
