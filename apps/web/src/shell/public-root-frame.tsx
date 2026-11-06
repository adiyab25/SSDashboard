import { notFound } from 'next/navigation';
import { directionOf, type Catalog } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { Providers } from '@/app/providers';
import { matchPublicLanguage } from '@/i18n/public-language';
import { SkipLink } from '@/shell/skip-link';
import { rootFontClassName } from './root-fonts';
import '@/app/globals.css';

/** Picks one group out of a catalog, or an empty one. */
function group(source: Catalog | string | undefined): Catalog {
  return typeof source === 'object' ? source : {};
}

/**
 * Only what the public pages read, so the page does not carry the staff strings: the skip link,
 * the not found text, and the portal and partner page groups.
 */
function publicCatalog(source: Catalog): Catalog {
  const shell = group(source.shell);
  return {
    shell: { skipLink: shell.skipLink ?? '', notFound: group(shell.notFound) },
    portal: group(source.portal),
    partner: group(source.partner),
  };
}

/**
 * The document of the public audiences, portal and partner (spec 0004, AC-16). The language
 * comes from the URL, so `<html lang dir>` is right in the first byte: no head script, no hidden
 * body, no swap after hydration. The client provider starts in that language with only the
 * groups these pages use, handed over from the server. `segment` is the raw `lang` root
 * parameter; anything but `en` or `ar` is a 404 before it is used. It must never read cookies or
 * headers (the proxy owns the language choice) and never call a staff api route.
 */
export function PublicRootFrame({
  segment,
  children,
}: {
  segment: string | undefined;
  children: React.ReactNode;
}) {
  const language = matchPublicLanguage(segment);
  if (!language) notFound();
  const catalog = language === 'ar' ? publicCatalog(ar) : {};
  return (
    <html
      lang={language}
      dir={directionOf(language)}
      className={rootFontClassName}
      suppressHydrationWarning
    >
      <body>
        <Providers initialLanguage={{ language, catalog }}>
          <SkipLink />
          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-2xl p-6 outline-none"
          >
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
