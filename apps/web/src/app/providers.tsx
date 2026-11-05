'use client';

import { Toaster } from '@ssdashboard/ui/components/sonner';
import { TooltipProvider } from '@ssdashboard/ui/components/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState } from 'react';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/i18n/language-provider';
import { CurrentLocationProvider } from '@/shell/current-location';

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
 * Browser state for the whole app: theme, language and direction, the current location, and
 * server state through TanStack Query (spec 0006).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider>
          <CurrentLocationProvider>
            <TooltipProvider>
              {children}
              <Toaster position="bottom-center" duration={6000} />
            </TooltipProvider>
          </CurrentLocationProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
