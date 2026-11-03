import { createAuthClient } from 'better-auth/client';

let client: ReturnType<typeof createAuthClient> | undefined;

/**
 * The Better Auth client for the sign in screens. Created on first use in the browser: it needs
 * the page's own origin, and nothing per client is baked into the web image.
 */
export function authClient() {
  client ??= createAuthClient({ baseURL: window.location.origin });
  return client;
}
