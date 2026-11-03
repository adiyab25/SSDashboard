// Plain module (not 'use client'), so the server layout gets real values, not client references.

export const LANGUAGE_COOKIE = 'ss_lang';
export const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** A language code: two or three lowercase letters. */
export const LANGUAGE_CODE = /^[a-z]{2,3}$/;

/** Languages written right to left, by base code. */
export const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb'] as const;

export type TextDirection = 'ltr' | 'rtl';

export function directionOf(code: string): TextDirection {
  return (RTL_LANGUAGES as readonly string[]).includes(code) ? 'rtl' : 'ltr';
}

/** How long the page stays hidden while a language other than English loads. */
export const HIDE_CAP_MS = 2000;

/**
 * Runs in `<head>` before first paint, in production too. Sets `lang` and `dir` from the
 * cookie, and for a language other than English hides the body (`data-i18n="pending"`)
 * until the provider has applied the catalog. The script arms its own timer, so a catalog
 * that never loads cannot leave a blank page.
 */
export const languageScript = `try{var m=document.cookie.match(/(?:^|;\\s*)${LANGUAGE_COOKIE}=([^;]*)/);var c=m&&m[1];if(c&&${LANGUAGE_CODE}.test(c)){var h=document.documentElement;h.lang=c;h.dir=${JSON.stringify(RTL_LANGUAGES)}.indexOf(c)>-1?'rtl':'ltr';if(c!=='en'){h.setAttribute('data-i18n','pending');setTimeout(function(){h.removeAttribute('data-i18n')},${HIDE_CAP_MS})}}}catch(e){}`;
