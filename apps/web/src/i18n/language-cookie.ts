import { LANGUAGE_CODE, LANGUAGE_COOKIE, LANGUAGE_COOKIE_MAX_AGE } from './language-config';

/** The saved language code, or null when there is none or it is not a 2 to 3 letter code. */
export function readLanguageCookie(): string | null {
  const value = new RegExp(`(?:^|;\\s*)${LANGUAGE_COOKIE}=([^;]*)`).exec(document.cookie)?.[1];
  return value && LANGUAGE_CODE.test(value) ? value : null;
}

/** Saves the language code for a year; ignores anything that is not a 2 to 3 letter code. */
export function writeLanguageCookie(code: string): void {
  if (!LANGUAGE_CODE.test(code)) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${LANGUAGE_COOKIE}=${code}; Path=/; Max-Age=${LANGUAGE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}
