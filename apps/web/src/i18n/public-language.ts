import { CORE_LANGUAGES, type CoreLanguage } from '@ssdashboard/i18n';

/** The two languages the portal and partner audiences serve, in URL order. */
export const PUBLIC_LANGUAGES: readonly CoreLanguage[] = ['en', 'ar'];

/** The static params of both public audiences: one entry per language. */
export function publicStaticParams(): { lang: CoreLanguage }[] {
  return PUBLIC_LANGUAGES.map((lang) => ({ lang }));
}

/**
 * Matches a URL segment against the served languages before anything uses it, so a request can
 * never reflect its own text into the document. Returns null for anything but `en` or `ar`.
 */
export function matchPublicLanguage(segment: string | undefined): CoreLanguage | null {
  return PUBLIC_LANGUAGES.find((language) => language === segment) ?? null;
}

/** The other served language: `en` for `ar`, `ar` for `en`. */
export function otherPublicLanguage(language: CoreLanguage): CoreLanguage {
  return language === 'ar' ? 'en' : 'ar';
}

/** Native name of a served language, for the link that switches to it. */
export function nativeNameOf(language: CoreLanguage): string {
  return CORE_LANGUAGES[language].nativeName;
}
