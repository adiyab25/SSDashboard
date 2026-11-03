'use client';

import { TooltipProvider } from '@ssdashboard/ui/components/tooltip';
import { ThemeProvider } from 'next-themes';
import { DirectionBridge } from '@/shell/direction';

/** Browser state for the whole app: theme, direction, and (later) the current location. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <DirectionBridge>
        <TooltipProvider>{children}</TooltipProvider>
      </DirectionBridge>
    </ThemeProvider>
  );
}
