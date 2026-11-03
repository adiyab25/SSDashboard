import { isAuthPath, signInUrl } from './return-to';

/** Browser state for the redirect, kept apart so a second 401 does not start a second one. */
let redirecting = false;

/** Sends the person to sign in, bringing them back to the page they are on (spec 0005, AC-5). */
export function redirectToSignIn(): void {
  if (redirecting) return;
  const { pathname, search } = window.location;
  // The screens outside the shell (sign in, reset) are where a signed out person belongs.
  if (isAuthPath(pathname)) return;
  redirecting = true;
  window.location.assign(signInUrl(`${pathname}${search}`));
}

/**
 * `fetch` for `/api` calls that need a session. A 401 (no session, or an expired one) sends the
 * person to sign in; the response is still returned so the caller can stop quietly.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) redirectToSignIn();
  return response;
}

/** Forgets that a redirect started, so a test begins from a clean slate. */
export function resetApiFetchForTests(): void {
  redirecting = false;
}
