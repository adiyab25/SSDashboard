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

/**
 * Where to send the browser after sign in (spec 0005, AC-7). Only a path on this site is
 * accepted: it must start with one `/` (not `//` or `/\`), carry no control characters or
 * backslashes (browsers read those as another slash), resolve to our own origin, and not be
 * one of the auth screens. Anything else, or nothing, goes to `/`.
 */
export function safeReturnTo(
  value: string | null | undefined,
  origin = 'http://localhost',
): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/';

  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return '/';
  }
  if (url.origin !== origin) return '/';
  if (isAuthPath(url.pathname)) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign in page address that brings the person back to `path` afterwards. */
export function signInUrl(path: string): string {
  return path === '/' ? '/sign-in' : `/sign-in?returnTo=${encodeURIComponent(path)}`;
}
