'use client';

import { TooltipProvider } from '@ssdashboard/ui/components/tooltip';
import { ThemeProvider } from 'next-themes';
import { CurrentLocationProvider } from '@/shell/current-location';
import { DirectionBridge } from '@/shell/direction';

/** Browser state for the whole app: theme, direction, and the current location. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <DirectionBridge>
        <CurrentLocationProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </CurrentLocationProvider>
      </DirectionBridge>
    </ThemeProvider>
  );
}
