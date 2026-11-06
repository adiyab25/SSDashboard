import { Activity } from 'react';
import { languageScript } from '@/i18n/language-config';
import { Providers } from '@/app/providers';
import { SkipLink } from '@/shell/skip-link';
import { rootFontClassName } from './root-fonts';
import '@/app/globals.css';

/**
 * The document of the staff back office and the sign in screens (spec 0004, AC-17), shared by
 * their two root layouts so they behave exactly as the single root layout did. It is static
 * (cache components): no `cookies()` or `headers()` here. Theme, language, and direction are
 * browser state, applied before paint by next-themes and the language head script. The server
 * markup is always English left to right; the saved language is applied after hydration, so
 * the markup and the first client render match. It must never read a request value, and the
 * portal and partner audiences must never use it (they render the language on the server).
 *
 * The audience frame sits in its own `<Activity>`, the boundary Next.js put around it when it
 * was a nested segment under the single root layout (cache components wrap every child segment
 * in one). React hydrates it as a separate unit after the small document commits, so the page
 * becomes interactive as early as it did before the split; without it the whole shell hydrated
 * in the root's slow pass and text typed right after the page appeared was lost. Never remove it.
 */
export function StaticRootFrame({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" className={rootFontClassName} suppressHydrationWarning>
      {/* App Router root layout: a plain <head> is the only way to run a script before first paint. */}
      {/* eslint-disable-next-line @next/next/no-head-element */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: languageScript }} />
      </head>
      <body>
        <Providers>
          <SkipLink />
          <Activity mode="visible">{children}</Activity>
        </Providers>
      </body>
    </html>
  );
}
