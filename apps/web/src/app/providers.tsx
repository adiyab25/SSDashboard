'use client';

import { Toaster } from '@ssdashboard/ui/components/sonner';
import { TooltipProvider } from '@ssdashboard/ui/components/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useEffect, useState } from 'react';
import { ApiError } from '@/api/client';
import { onModuleRefusal } from '@/auth/api-fetch';
import { moduleKeys } from '@/shell/module-states-api';
import { LanguageProvider, type InitialLanguage } from '@/i18n/language-provider';

/** One query client per browser tab. A refused request (4xx) is an answer, never retried. */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failures, error) =>
          failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Browser state for every audience: theme, language and direction, tooltips, and server state
 * through TanStack Query (spec 0006). Nothing here calls a staff api route, so the public portal
 * stays anonymous; the current location lives in the (backoffice) layout. The public audiences pass
 * `initialLanguage` from the server (spec 0004, AC-16); the back office and sign in do not.
 */
export function Providers({
  children,
  initialLanguage,
}: {
  children: React.ReactNode;
  initialLanguage?: InitialLanguage;
}) {
  const [queryClient] = useState(makeQueryClient);
  // Spec 0009, AC-9: an api answer of 404 MODULE_OFF or 409 MODULE_LIMITED makes the shell read the
  // module states again at once. `apiFetch` reports it, so every call is covered, in one place.
  useEffect(
    () =>
      onModuleRefusal(() => {
        void queryClient.invalidateQueries(
          { queryKey: moduleKeys.all },
          // A burst of refusals shares the read already running instead of aborting it.
          { cancelRefetch: false },
        );
      }),
    [queryClient],
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider initial={initialLanguage}>
          <TooltipProvider>
            {children}
            <Toaster position="bottom-center" duration={6000} />
          </TooltipProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
