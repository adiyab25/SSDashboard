'use client';

import { TooltipProvider } from '@ssdashboard/ui/components/tooltip';
import { ThemeProvider } from 'next-themes';
import { LanguageProvider } from '@/i18n/language-provider';
import { CurrentLocationProvider } from '@/shell/current-location';

/** Browser state for the whole app: theme, language and direction, and the current location. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <LanguageProvider>
        <CurrentLocationProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </CurrentLocationProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
