import { changePasswordUrl, isAuthPath, signInUrl } from './return-to';

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

/** Sends a person with a temporary password to change it first (spec 0005, AC-14). */
export function redirectToChangePassword(): void {
  if (redirecting) return;
  const { pathname, search } = window.location;
  if (isAuthPath(pathname)) return;
  redirecting = true;
  window.location.assign(changePasswordUrl(`${pathname}${search}`));
}

/** Who wants to hear that an api answer said a module's state changed (spec 0009, AC-9). */
const refusalListeners = new Set<() => void>();

/**
 * Calls `listener` whenever any `apiFetch` answer is 404 `MODULE_OFF` or 409 `MODULE_LIMITED`,
 * and returns the way to stop listening. The shell uses it to read the module states again at
 * once; being here means every caller is covered, query or not.
 */
export function onModuleRefusal(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => refusalListeners.delete(listener);
}

/**
 * `fetch` for `/api` calls that need a session. A 401 (no session, or an expired one) sends the
 * person to sign in, and a 403 `PASSWORD_CHANGE_REQUIRED` sends them to change their password;
 * the response is still returned so the caller can stop quietly. A 404 `MODULE_OFF` or 409
 * `MODULE_LIMITED` tells the `onModuleRefusal` listeners.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) redirectToSignIn();
  else if (response.status === 403) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    if (body?.code === 'PASSWORD_CHANGE_REQUIRED') redirectToChangePassword();
  } else if ((response.status === 404 || response.status === 409) && refusalListeners.size > 0) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    const refused =
      (response.status === 404 && body?.code === 'MODULE_OFF') ||
      (response.status === 409 && body?.code === 'MODULE_LIMITED');
    if (refused) for (const listener of refusalListeners) listener();
  }
  return response;
}

/** Forgets that a redirect started, so a test begins from a clean slate. */
export function resetApiFetchForTests(): void {
  redirecting = false;
}
