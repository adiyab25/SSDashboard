import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { languageScript } from '@/i18n/language-config';
import { SkipLink } from '@/shell/skip-link';
import { Providers } from './providers';
import './globals.css';

// Downloaded at build time and served by the app: no request to a font host at runtime.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-sans',
});

// Not preloaded, so English pages never download it; `:lang(ar)` switches to it.
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  preload: false,
  variable: '--font-plex-arabic',
});

export const metadata: Metadata = {
  title: 'SSDashboard',
  description: 'Warehouse and ERP back office',
};

// Static under cacheComponents: no cookies() or headers() here. Theme, language, and
// direction are browser state, applied before paint by next-themes and the language script.
// The server markup is always English left to right; the saved language is applied after
// hydration (spec 0004), so the markup and the first client render match.
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      dir="ltr"
      className={`${plexSans.variable} ${plexArabic.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: languageScript }} />
      </head>
      <body>
        <Providers>
          <SkipLink />
          {children}
        </Providers>
      </body>
    </html>
  );
}
