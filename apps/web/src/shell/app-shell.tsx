'use client';

import { SidebarProvider } from '@ssdashboard/ui/components/sidebar';
import { AppSidebar } from './app-sidebar';
import { TopBar } from './top-bar';

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
