import type { Metadata } from 'next';
import { createTranslatorSync } from '@ssdashboard/i18n';
import { rootFontClassName } from '@/shell/root-fonts';
import './globals.css';

/** Title of the not found document. */
export const metadata: Metadata = { title: 'SSDashboard' };

/**
 * The 404 of the whole app (experimental `globalNotFound`), used for any URL no route matches
 * and for the development only paths in production. With several root layouts there is no
 * single layout to build it from, so it is a full document of its own: English, one heading, no
 * business data, no language script and no providers.
 */
export default function GlobalNotFound() {
  const { t, language, dir } = createTranslatorSync('en');
  return (
    <html lang={language} dir={dir} className={rootFontClassName}>
      <body>
        <main className="mx-auto flex w-full max-w-2xl flex-col gap-2 p-6">
          <h1 className="text-xl font-semibold">{t('shell.notFound.title')}</h1>
          <p className="text-muted-foreground">{t('shell.notFound.description')}</p>
        </main>
      </body>
    </html>
  );
}
