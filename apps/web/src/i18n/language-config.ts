// Plain module (not 'use client'), so the server layout gets real values, not client references.
import { RTL_LANGUAGES } from '@ssdashboard/i18n';

/** Name of the cookie that holds the chosen language. */
export const LANGUAGE_COOKIE = 'ss_lang';
/** How long the language cookie lasts, in seconds (a year). */
export const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** A language code: two or three lowercase letters. */
export const LANGUAGE_CODE = /^[a-z]{2,3}$/;

/** How long the page stays hidden while a language other than English loads. */
export const HIDE_CAP_MS = 10_000;

/**
 * Runs in `<head>` before first paint, in production too. Sets `lang` and `dir` from the
 * cookie, and for a language other than English hides the body (`data-i18n="pending"`)
 * until the provider has applied the catalog. The script arms its own timer, so a catalog
 * that never loads cannot leave a blank page.
 */
export const languageScript = `try{var m=document.cookie.match(/(?:^|;\\s*)${LANGUAGE_COOKIE}=([^;]*)/);var c=m&&m[1];if(c&&${LANGUAGE_CODE}.test(c)){var h=document.documentElement;h.lang=c;h.dir=${JSON.stringify(RTL_LANGUAGES)}.indexOf(c)>-1?'rtl':'ltr';if(c!=='en'){h.setAttribute('data-i18n','pending');setTimeout(function(){h.removeAttribute('data-i18n')},${HIDE_CAP_MS})}}}catch(e){}`;
