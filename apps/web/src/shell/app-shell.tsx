'use client';

import { SidebarProvider } from '@ssdashboard/ui/components/sidebar';
import { Suspense } from 'react';
import { AppSidebar } from './app-sidebar';
import { ModulePageGate } from './module-page-gate';
import { TopBar } from './top-bar';

/**
 * The frame every page renders in: sidebar, top bar, and the single main landmark, whose body the
 * module gate may replace with the "not available on this install" state (spec 0009, AC-9).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main-content" tabIndex={-1} className="flex-1 p-6 outline-none">
          <Suspense fallback={children}>
            <ModulePageGate>{children}</ModulePageGate>
          </Suspense>
        </main>
      </div>
    </SidebarProvider>
  );
}
