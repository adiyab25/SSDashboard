/** The scope used when no address can be read (a request that skipped the proxy). */
export const UNKNOWN_IP = 'unknown';

/**
 * The client address: the first value of `X-Forwarded-For`, which Caddy sets and overwrites
 * (spec 0005 value sourcing). Better Auth's rate limiter reads the same header.
 */
export function clientIp(headers: Headers | undefined): string {
  const first = headers?.get('x-forwarded-for')?.split(',')[0]?.trim();
  // `*` is the lockout row that counts every address, so it can never be a real address.
  return first && first !== '*' ? first : UNKNOWN_IP;
}

/**
 * The browser's `User-Agent` header cut to 300 characters for audit lines, or null when absent.
 * Never log the full header: it is client controlled and unbounded.
 */
export function userAgent(headers: Headers | undefined): string | null {
  return headers?.get('user-agent')?.slice(0, 300) ?? null;
}

/** The lockout key: the email text as typed, trimmed and lowercased, and capped in length. */
export function emailKey(email: string): string {
  return email.trim().toLowerCase().slice(0, 320);
}
