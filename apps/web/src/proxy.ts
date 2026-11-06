import { NextResponse, type NextRequest } from 'next/server';
import { choosePublicLanguage } from '@/i18n/choose-public-language';
import { LANGUAGE_COOKIE, LANGUAGE_COOKIE_MAX_AGE } from '@/i18n/language-config';
import { matchPublicLanguage } from '@/i18n/public-language';

/** Pages that exist only in development: the design system gallery (spec 0003, AC-13). */
const DEV_ONLY_PATHS = /^\/design(\/|$)/;

/** A portal or partner path with no language in front of it, such as `/returns`. */
const UNPREFIXED_PUBLIC = /^\/(returns|partner)(\/|$)/;

/** A portal or partner path with one segment in front of it, which must be a language code. */
const PREFIXED_PUBLIC = /^\/([^/]+)\/(returns|partner)(\/|$)/;

/**
 * Back office sections that own nested pages (`/skus/<id>`, `/stock-receipts/new`). A path under
 * them is theirs, never read as `/<language>/returns`, so the proxy leaves it alone.
 */
const BACK_OFFICE_SECTIONS = new Set(['skus', 'stock-receipts']);

/** Answers a real 404 (the response status is sent before the page renders, unlike `notFound()`). */
function notFoundResponse(request: NextRequest) {
  return NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 });
}

/**
 * Hands the requested path (and query) to the server components as `x-pathname`, because a
 * layout cannot read it and the session check needs it for `returnTo`. It always overwrites
 * the header, so a browser cannot choose its own value.
 *
 * It also decides what must be known before the page renders, where a `notFound()` in the page
 * would answer 200 with the not found screen streamed in:
 * - the development only pages in production are a real 404;
 * - a portal or partner path without a language is redirected (307) to the same path and query
 *   with `/en` or `/ar` (cookie `ss_lang` as `en`, `ar`, or `en` for another language code; then `Accept-Language`
 *   when the cookie is absent or not a code; then Arabic; spec 0004, AC-16, AC-23), with
 *   `Cache-Control: private, no-store`;
 * - a portal or partner path with a first segment other than `en` or `ar` (`/english/returns`,
 *   `/en-US/partner`, `/EN/returns`) is a real 404, except under the back office sections that
 *   own nested pages;
 * - a portal or partner path with a valid language refreshes the `ss_lang` cookie, only when it is
 *   absent or already `en` or `ar` (a client language such as `fr` is kept).
 *
 * The back office and sign in paths are never redirected. It is not an authorization layer.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (process.env.NODE_ENV === 'production' && DEV_ONLY_PATHS.test(pathname)) {
    return notFoundResponse(request);
  }

  if (UNPREFIXED_PUBLIC.test(pathname)) {
    const language = choosePublicLanguage(
      request.cookies.get(LANGUAGE_COOKIE)?.value,
      request.headers.get('accept-language'),
    );
    const target = request.nextUrl.clone();
    target.pathname = `/${language}${pathname}`;
    const redirect = NextResponse.redirect(target, 307);
    // The answer depends on the cookie and Accept-Language, so no cache may keep it.
    redirect.headers.set('Cache-Control', 'private, no-store');
    return redirect;
  }

  const prefixed = PREFIXED_PUBLIC.exec(pathname);
  const segment = prefixed?.[1];
  if (
    segment !== undefined &&
    !BACK_OFFICE_SECTIONS.has(segment) &&
    !matchPublicLanguage(segment)
  ) {
    return notFoundResponse(request);
  }

  const headers = new Headers(request.headers);
  headers.set('x-pathname', `${pathname}${search}`);
  const response = NextResponse.next({ request: { headers } });

  const language = matchPublicLanguage(segment);
  // A client language the visitor chose elsewhere (`fr`) is never overwritten by a visit here.
  const saved = request.cookies.get(LANGUAGE_COOKIE)?.value;
  if (language && (saved === undefined || matchPublicLanguage(saved))) {
    const secure =
      request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
    // Same attributes as the browser's own write (language-cookie.ts); readable by scripts.
    response.cookies.set(LANGUAGE_COOKIE, language, {
      path: '/',
      maxAge: LANGUAGE_COOKIE_MAX_AGE,
      sameSite: 'lax',
      secure,
      httpOnly: false,
    });
  }
  return response;
}

/** The pages the proxy runs on; see the matcher for what it skips. */
export const config = {
  // Pages only: not the api, Next's own files, language files, or anything with an extension.
  matcher: ['/((?!api/|_next/|locales/|.*\\..*).*)'],
};
