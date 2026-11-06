import { Inter, JetBrains_Mono, Noto_Sans_Arabic } from 'next/font/google';

// Daftar type (spec 0003, Option B). Downloaded at build time and served by the app: no request
// to a font host at runtime. Weight is omitted so each family is its variable file.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

// Not preloaded, so English pages never download it; `:lang(ar)` switches to it.
const notoArabic = Noto_Sans_Arabic({
  subsets: ['arabic'],
  display: 'swap',
  preload: false,
  variable: '--font-noto-arabic',
});

// Codes and the `/design` code specimen; not preloaded.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  variable: '--font-jetbrains-mono',
});

/**
 * The class names that put the three font families (Inter, Noto Sans Arabic, JetBrains Mono) on
 * `<html>` as the CSS variables `--font-inter`, `--font-noto-arabic`, and `--font-jetbrains-mono`.
 * Every root layout (back office, sign in, portal, partner) uses it, so the fonts load the same
 * way everywhere. It must never be applied to anything but the `<html>` element.
 */
export const rootFontClassName = `${inter.variable} ${notoArabic.variable} ${jetbrainsMono.variable}`;
