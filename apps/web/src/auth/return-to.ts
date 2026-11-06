import type { Home } from '@ssdashboard/contracts';

/** The screens outside the app shell. Landing on one after sign in would loop. */
const AUTH_PATHS = [
  '/sign-in',
  '/forgot-password',
  '/reset-password',
  '/two-factor',
  '/change-password',
];

/** True for a path that belongs to the screens outside the shell, where nobody has a session yet. */
export function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** The page a person lands on when nothing better is asked for (spec 0005, AC-28). */
export const HOME_PATH: Record<Home, string> = { backoffice: '/', partner: '/partner' };

/** The partner pages: `/partner` and `/<en|ar>/partner`, with anything below them. */
const PARTNER_PATH = /^\/(?:(?:en|ar)\/)?partner(?:\/|$)/;

/** The public exchange and return portal: `/returns` and `/<en|ar>/returns`. */
const PORTAL_PATH = /^\/(?:(?:en|ar)\/)?returns(?:\/|$)/;

/**
 * The path as a browser or a router could read it: percent escapes decoded and lowercased, so
 * `/%70artner` and `/EN/partner` are recognized as partner pages. Null for a malformed escape.
 */
function readablePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `pathname` is a page of the audience `home` names (spec 0005, AC-28). A partner user
 * owns the partner pages only; a staff person owns every other page except the partner pages and
 * the public portal. The path is decoded and lowercased before the test, so an escaped or
 * capitalized partner or portal path is still refused to staff; a partner user keeps only the
 * plain spelling the partner routes answer. A malformed escape belongs to nobody. The auth
 * screens belong to nobody here either: `safeReturnTo` rejects them first.
 */
export function isInAudience(pathname: string, home: Home): boolean {
  const readable = readablePath(pathname);
  if (readable === null) return false;
  if (home === 'partner') return PARTNER_PATH.test(pathname) && PARTNER_PATH.test(readable);
  return !PARTNER_PATH.test(readable) && !PORTAL_PATH.test(readable);
}

/** Control characters and backslashes, which browsers strip or read as another slash. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const UNSAFE_CHARACTER = /[\\\u0000-\u001f\u007f]/;

/** True for text that starts with exactly one `/` and carries no control character or backslash. */
function isPlainPath(text: string): boolean {
  return text.startsWith('/') && !text.startsWith('//') && !UNSAFE_CHARACTER.test(text);
}

/**
 * Where to send the browser after sign in (spec 0005, AC-7, AC-28). Only a path on this site is
 * accepted: it must start with one `/` (not `//` or `/\`), carry no control characters or
 * backslashes (browsers read those as another slash), resolve to our own origin, and not be
 * one of the auth screens, and it must point into the pages of the person's own audience `home`
 * (a partner user asking for `/stock` lands on `/partner`). The single slash and character rules
 * run again on the answer after URL normalization, because dot segments (`/.//x`, `/%2e//x`,
 * `/a/..//x`) collapse into a protocol relative `//x` there. Anything else, or nothing, goes to
 * the home page of that audience. It must never return text that starts with `//` or `/\`.
 */
export function safeReturnTo(
  value: string | null | undefined,
  origin = 'http://localhost',
  home: Home = 'backoffice',
): string {
  const fallback = HOME_PATH[home];
  if (!value || !isPlainPath(value)) return fallback;

  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  const answer = `${url.pathname}${url.search}${url.hash}`;
  // Checked again on the normalized answer, not only the input: see the note above.
  if (!isPlainPath(url.pathname) || !isPlainPath(answer)) return fallback;
  if (isAuthPath(url.pathname)) return fallback;
  if (!isInAudience(url.pathname, home)) return fallback;
  return answer;
}

/** The forced change password page, which brings the person back to `path` afterwards. */
export function changePasswordUrl(path: string): string {
  return path === '/'
    ? '/change-password'
    : `/change-password?returnTo=${encodeURIComponent(path)}`;
}

/** The sign in page address that brings the person back to `path` afterwards. */
export function signInUrl(path: string): string {
  return path === '/' ? '/sign-in' : `/sign-in?returnTo=${encodeURIComponent(path)}`;
}
