import type { CoreLanguage } from '@ssdashboard/i18n';
import { LANGUAGE_CODE } from './language-config';
import { matchPublicLanguage } from './public-language';

/** The language a visitor gets when neither the cookie nor the browser names one we serve. */
export const DEFAULT_PUBLIC_LANGUAGE: CoreLanguage = 'ar';

/**
 * The first served language in an `Accept-Language` header, highest `q` first (ties keep the
 * header's order); a region counts as its base language, so `ar-EG` is `ar`. `q=0` means "not
 * acceptable" and is skipped. Returns null when the header names neither `en` nor `ar`.
 */
export function languageFromAcceptHeader(header: string | null): CoreLanguage | null {
  if (!header) return null;
  const ranked = header.split(',').flatMap((part, index) => {
    const [tag = '', ...params] = part.trim().split(';');
    const language = matchPublicLanguage(tag.trim().toLowerCase().split('-')[0]);
    if (!language) return [];
    const qParam = params.map((param) => param.trim()).find((param) => /^q=/i.test(param));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    return Number.isFinite(q) && q > 0 ? [{ language, q, index }] : [];
  });
  ranked.sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked[0]?.language ?? null;
}

/**
 * Which language an unprefixed portal or partner path redirects to (spec 0004, AC-16, AC-23):
 * the `ss_lang` cookie if it is `en` or `ar`; a cookie that is a valid language code but not
 * served here (a client language such as `fr`) gives `en`, because these pages have no other
 * catalog; only a cookie that is absent or not a language code (`FR!`, `english`, `EN`) falls to
 * the browser's `Accept-Language`, then Arabic. It reads values the caller hands over and never
 * touches a request itself.
 */
export function choosePublicLanguage(
  cookieValue: string | undefined,
  acceptLanguage: string | null,
): CoreLanguage {
  const served = matchPublicLanguage(cookieValue);
  if (served) return served;
  if (cookieValue !== undefined && LANGUAGE_CODE.test(cookieValue)) return 'en';
  return languageFromAcceptHeader(acceptLanguage) ?? DEFAULT_PUBLIC_LANGUAGE;
}
