import { NextResponse, type NextRequest } from 'next/server';

/**
 * Hands the requested path (and query) to the server components as `x-pathname`, because a
 * layout cannot read it and the session check needs it for `returnTo`. It always overwrites
 * the header, so a browser cannot choose its own value. It decides nothing else.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only: not the api, Next's own files, language files, or anything with an extension.
  matcher: ['/((?!api/|_next/|locales/|.*\\..*).*)'],
};
