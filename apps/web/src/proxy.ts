import { NextResponse, type NextRequest } from 'next/server';

/** Pages that exist only in development: the design system gallery (spec 0003, AC-13). */
const DEV_ONLY_PATHS = /^\/design(\/|$)/;

/**
 * Hands the requested path (and query) to the server components as `x-pathname`, because a
 * layout cannot read it and the session check needs it for `returnTo`. It always overwrites
 * the header, so a browser cannot choose its own value.
 *
 * The one other thing it decides is the development only pages in production: a `notFound()` in
 * the page runs behind the session check's Suspense, after the response status is sent, so it
 * would answer 200 with the not found screen streamed in. Here it is still a real 404.
 */
export function proxy(request: NextRequest) {
  if (process.env.NODE_ENV === 'production' && DEV_ONLY_PATHS.test(request.nextUrl.pathname)) {
    return NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 });
  }
  const headers = new Headers(request.headers);
  headers.set('x-pathname', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

/** The pages the proxy runs on; see the matcher for what it skips. */
export const config = {
  // Pages only: not the api, Next's own files, language files, or anything with an extension.
  matcher: ['/((?!api/|_next/|locales/|.*\\..*).*)'],
};
