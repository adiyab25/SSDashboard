import { Suspense } from 'react';
import { SessionGate } from '@/auth/session-gate';
import { AppShell } from '@/shell/app-shell';
import { CurrentLocationProvider } from '@/shell/current-location-provider';

/**
 * The staff frame is static and the session check streams in behind it. The location provider
 * sits here, not in the root, because it calls the staff `/api/locations` and a 401 there
 * sends the visitor to sign in: the public portal must never trigger that.
 */
export default function BackofficeLayout({ children }: LayoutProps<'/'>) {
  return (
    <CurrentLocationProvider>
      <AppShell>
        <Suspense fallback={null}>
          <SessionGate>{children}</SessionGate>
        </Suspense>
      </AppShell>
    </CurrentLocationProvider>
  );
}
