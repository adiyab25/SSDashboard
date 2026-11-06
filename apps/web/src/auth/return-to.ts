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
 * True when `pathname` is a page of the audience `home` names (spec 0005, AC-28). A partner user
 * owns the partner pages only; a staff person owns every other page except the partner pages and
 * the public portal. The auth screens belong to nobody here: `safeReturnTo` rejects them first.
 */
export function isInAudience(pathname: string, home: Home): boolean {
  if (home === 'partner') return PARTNER_PATH.test(pathname);
  return !PARTNER_PATH.test(pathname) && !PORTAL_PATH.test(pathname);
}

/**
 * Where to send the browser after sign in (spec 0005, AC-7, AC-28). Only a path on this site is
 * accepted: it must start with one `/` (not `//` or `/\`), carry no control characters or
 * backslashes (browsers read those as another slash), resolve to our own origin, and not be
 * one of the auth screens, and it must point into the pages of the person's own audience `home`
 * (a partner user asking for `/stock` lands on `/partner`). Anything else, or nothing, goes to
 * the home page of that audience.
 */
export function safeReturnTo(
  value: string | null | undefined,
  origin = 'http://localhost',
  home: Home = 'backoffice',
): string {
  const fallback = HOME_PATH[home];
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;

  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  if (isAuthPath(url.pathname)) return fallback;
  if (!isInAudience(url.pathname, home)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
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
