import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { DIRECTION_SWITCH, directionScript } from '@/shell/direction';
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

// Static under cacheComponents: no cookies() or headers() here. Theme and direction are
// browser state, applied before paint by next-themes and the development direction script.
// Language and direction switching come with feature 5 (localization).
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      dir="ltr"
      className={`${plexSans.variable} ${plexArabic.variable}`}
      suppressHydrationWarning
    >
      <head>
        {DIRECTION_SWITCH && <script dangerouslySetInnerHTML={{ __html: directionScript }} />}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
