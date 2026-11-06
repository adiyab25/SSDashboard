import { Suspense } from 'react';
import { SessionGate } from '@/auth/session-gate';
import { AppShell } from '@/shell/app-shell';
import { CurrentLocationProvider } from '@/shell/current-location-provider';
import { rootMetadata } from '@/shell/root-metadata';
import { StaticRootFrame } from '@/shell/static-root-frame';

/** Page title and description of the back office. */
export const metadata = rootMetadata;

/**
 * Root layout of the staff back office: the shared static document, then the staff frame, which
 * is static with the session check streaming in behind it. The location provider sits here, not
 * in the document, because it calls the staff `/api/locations` and a 401 there sends the visitor
 * to sign in: the public portal must never trigger that.
 */
export default function BackofficeLayout({ children }: LayoutProps<'/'>) {
  return (
    <StaticRootFrame>
      <CurrentLocationProvider>
        <AppShell>
          <Suspense fallback={null}>
            <SessionGate>{children}</SessionGate>
          </Suspense>
        </AppShell>
      </CurrentLocationProvider>
    </StaticRootFrame>
  );
}
