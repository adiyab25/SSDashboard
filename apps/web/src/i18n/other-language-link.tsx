import type { CoreLanguage } from '@ssdashboard/i18n';
import { nativeNameOf, otherPublicLanguage } from './public-language';

/**
 * A plain link to the same page in the other language. It is an ordinary `<a>`, so it works with
 * scripts blocked and is at least 44 by 44px (AC-20); opening the new path refreshes the `ss_lang` cookie in the proxy. `path` is
 * the page's own path without the language, such as `/returns`.
 */
export function OtherLanguageLink({ language, path }: { language: CoreLanguage; path: string }) {
  const other = otherPublicLanguage(language);
  return (
    <a
      href={`/${other}${path}`}
      lang={other}
      hrefLang={other}
      className="inline-flex min-h-11 min-w-11 w-fit items-center justify-center text-sm font-medium underline underline-offset-4"
    >
      {nativeNameOf(other)}
    </a>
  );
}
