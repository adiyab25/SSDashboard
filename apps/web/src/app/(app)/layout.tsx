import { Suspense } from 'react';
import { SessionGate } from '@/auth/session-gate';
import { AppShell } from '@/shell/app-shell';

// The frame is static; the session check is the only dynamic part and streams in behind it.
export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <SessionGate>{children}</SessionGate>
      </Suspense>
    </AppShell>
  );
}
