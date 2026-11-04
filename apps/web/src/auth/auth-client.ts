import { createAuthClient } from 'better-auth/client';
import { twoFactorClient } from 'better-auth/client/plugins';

/** Our own redirect handles the code step, so the plugin's built in one stays off. */
const create = (baseURL: string) => createAuthClient({ baseURL, plugins: [twoFactorClient()] });

let client: ReturnType<typeof create> | undefined;

/**
 * The Better Auth client for the sign in screens. Created on first use in the browser: it needs
 * the page's own origin, and nothing per client is baked into the web image.
 */
export function authClient() {
  client ??= create(window.location.origin);
  return client;
}
