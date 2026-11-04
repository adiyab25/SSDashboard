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
import { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/auth/use-me';
import { isActive, navGroups, visibleNavItems, type NavItem } from './nav';

/**
 * Closes the phone sheet once a page is picked. Its own Suspense leaf: the pathname is unknown
 * while Next.js prerenders a route with dynamic params (cache components).
 */
function CloseSheetOnNavigate() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}

interface LinksProps {
  items: NavItem[];
  /** Null while prerendering, so no entry is marked current. */
  pathname: string | null;
}

function NavLinks({ items, pathname }: LinksProps) {
  const { t } = useTranslation();
  return navGroups.map((group) => {
    const groupItems = items.filter((item) => item.group === group.id);
    if (groupItems.length === 0) return null;
    return (
      <SidebarGroup key={group.id}>
        <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
        <SidebarMenu>
          {groupItems.map((item) => {
            const active = pathname !== null && isActive(pathname, item.href);
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

function CurrentNavLinks({ items }: { items: NavItem[] }) {
  return <NavLinks items={items} pathname={usePathname()} />;
}

/** The navigation registry grouped by module; an icon rail when collapsed, a sheet on phones. */
export function AppSidebar() {
  const { t } = useTranslation();
  const me = useMe();
  const items = visibleNavItems(me?.role);

  // The close leaf sits outside the sidebar: on phones the sheet's content mounts only while
  // it is open, and an effect mounting with it would close it straight away.
  return (
    <>
      <Suspense fallback={null}>
        <CloseSheetOnNavigate />
      </Suspense>
      <Sidebar collapsible="icon" mobileLabel={t('shell.sidebar.mobileLabel')}>
        <SidebarContent>
          <nav aria-label={t('shell.nav.label')}>
            <Suspense fallback={<NavLinks items={items} pathname={null} />}>
              <CurrentNavLinks items={items} />
            </Suspense>
          </nav>
        </SidebarContent>
      </Sidebar>
    </>
  );
}
