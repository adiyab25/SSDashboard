'use client';

import { Button } from '@ssdashboard/ui/components/button';
import { SidebarProvider, SidebarTrigger, useSidebar } from '@ssdashboard/ui/components/sidebar';
import { MenuIcon } from 'lucide-react';
import { t } from '@/i18n/t';
import { AppSidebar } from './app-sidebar';
import { ClientName } from './client-name';
import { CommandPalette } from './command-palette';
import { LocationSwitcher } from './location-switcher';
import { UserMenu } from './user-menu';

function TopBar() {
  const { open, openMobile, setOpenMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-10 flex h-topbar shrink-0 items-center gap-2 border-b bg-background px-4">
      {/* Phones: the sidebar is a sheet. Shown with CSS so it never flashes before JS runs. */}
      <Button
        variant="ghost"
        size="icon"
        className="coarse:size-touch md:hidden"
        aria-label={t('shell.topbar.menu')}
        aria-expanded={openMobile}
        onClick={() => setOpenMobile(true)}
      >
        <MenuIcon aria-hidden />
      </Button>
      <SidebarTrigger
        label={t('shell.sidebar.toggle')}
        aria-expanded={open}
        className="coarse:size-touch max-md:hidden"
      />
      <ClientName className="min-w-0 truncate font-semibold" />
      <div className="ms-auto flex items-center gap-2">
        <LocationSwitcher />
        <CommandPalette />
        <UserMenu />
      </div>
    </header>
  );
}

/** The frame every page renders in: sidebar, top bar, and the single main landmark. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main-content" tabIndex={-1} className="flex-1 p-6 outline-none">
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
