import localFont from 'next/font/local';

// Daftar type (spec 0003, Option B). Self hosted: each family is one variable woff2 file committed
// in `./fonts/` (see its README), so building an image makes no request to a font host and the app
// makes none at runtime. `weight` is the file's weight axis range; `unicode-range` is the subset
// Google Fonts served for the same family, so each file is used only for the characters it was
// cut for.
//
// Family names: Turbopack builds each CSS variable from the const's JavaScript name (`notoArabic`),
// which has no spaces, while the `font-family` declaration gives the @font-face its real name
// (`Noto Sans Arabic`). `fallback` appends that real name to the variable, so the variable reaches
// the face. `adjustFontFallback: false` is required with it: the generated "<name> Fallback" face
// (local Arial) would otherwise sit in the list before the real family and always win.
const inter = localFont({
  src: './fonts/inter-latin-variable.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter',
  fallback: ['Inter'],
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

// Not preloaded, so English pages never download it; `:lang(ar)` switches to it.
const notoArabic = localFont({
  src: './fonts/noto-sans-arabic-arabic-variable.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--font-noto-arabic',
  fallback: ['Noto Sans Arabic'],
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'Noto Sans Arabic' },
    {
      prop: 'unicode-range',
      value:
        'U+0600-06FF, U+0750-077F, U+0870-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC7, U+10EC9-10EEE, U+10EF0-10EFF, U+1EE00-1EEF1',
    },
  ],
});

// Codes and the `/design` code specimen; not preloaded.
const jetbrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin-variable.woff2',
  weight: '100 800',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--font-jetbrains-mono',
  fallback: ['JetBrains Mono'],
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'JetBrains Mono' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

/**
 * The class names that put the three font families (Inter, Noto Sans Arabic, JetBrains Mono) on
 * `<html>` as the CSS variables `--font-inter`, `--font-noto-arabic`, and `--font-jetbrains-mono`.
 * The families are self hosted from the variable files in `./fonts/` through `next/font/local`, so
 * no part of a build or a page load reaches a font host. Every root layout (back office, sign in,
 * portal, partner) uses it, so the fonts load the same way everywhere. It must never be applied to
 * anything but the `<html>` element, and must never point at a remote font URL.
 */
export const rootFontClassName = `${inter.variable} ${notoArabic.variable} ${jetbrainsMono.variable}`;
