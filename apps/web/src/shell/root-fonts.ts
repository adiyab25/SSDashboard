import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';

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

/**
 * The class names that put both font families on `<html>` as CSS variables. Every root layout
 * (back office, sign in, portal, partner) uses it, so the fonts load the same way everywhere.
 * It must never be applied to anything but the `<html>` element.
 */
export const rootFontClassName = `${plexSans.variable} ${plexArabic.variable}`;
