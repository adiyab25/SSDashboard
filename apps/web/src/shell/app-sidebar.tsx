'use client';

import { Sidebar, SidebarContent } from '@ssdashboard/ui/components/sidebar';
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/auth/use-me';
import { CloseSheetOnNavigate } from './close-sheet-on-navigate';
import { CurrentNavLinks } from './current-nav-links';
import { NavLinks } from './nav-links';
import { visibleNavItems } from './nav';

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
