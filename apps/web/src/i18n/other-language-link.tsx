import type { CoreLanguage } from '@ssdashboard/i18n';
import { nativeNameOf, otherPublicLanguage } from './public-language';

/**
 * A plain link to the same page in the other language. It is an ordinary `<a>`, so it works with
 * scripts blocked; opening the new path refreshes the `ss_lang` cookie in the proxy. `path` is
 * the page's own path without the language, such as `/returns`.
 */
export function OtherLanguageLink({ language, path }: { language: CoreLanguage; path: string }) {
  const other = otherPublicLanguage(language);
  return (
    <a
      href={`/${other}${path}`}
      lang={other}
      hrefLang={other}
      className="w-fit text-sm font-medium underline underline-offset-4"
    >
      {nativeNameOf(other)}
    </a>
  );
}
