'use client';

import { ClientName } from '@/shell/client-name';
import { AuthPreferences } from './auth-preferences';

/**
 * The frame for the sign in screens (spec 0005, AC-24). They sit outside the app shell, a
 * documented exception to "every page renders inside the shell": there is no navigation
 * before sign in. The skip link target and the single `main` landmark still exist.
 */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate flex min-h-svh flex-col overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 gradient-glow" />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 gradient-grid" />
      <header className="flex h-topbar shrink-0 items-center gap-2 border-b px-4">
        <ClientName className="min-w-0 truncate font-semibold" />
        <div className="ms-auto">
          <AuthPreferences />
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 items-start justify-center p-6 outline-none sm:items-center"
      >
        <div className="w-full max-w-sm rounded-card gradient-card-edge max-sm:border-0 max-sm:bg-none sm:max-w-[calc(var(--container-sm)+3rem+2px)] sm:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
