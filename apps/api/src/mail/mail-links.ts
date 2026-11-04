import type { MailKind } from './mail-templates.js';

/** Better Auth stores a reset or invite token under this identifier prefix in `verifications`. */
export const TOKEN_IDENTIFIER_PREFIX = 'reset-password:';

/**
 * The link in the email (spec 0005, AC-9): Better Auth's token check, which sends the browser
 * on to our reset page with `?token=` when the token is good and `?error=INVALID_TOKEN` when
 * it is used or expired. The base is `PUBLIC_URL`, never a request header.
 */
export function tokenLink(publicUrl: string, token: string, kind: MailKind): string {
  const page = kind === 'invite' ? '/reset-password?invite=1' : '/reset-password';
  return `${publicUrl}/api/auth/reset-password/${encodeURIComponent(token)}?callbackURL=${encodeURIComponent(`${publicUrl}${page}`)}`;
}

/** The token inside a `verifications.identifier`, or undefined when it is not one of ours. */
export function tokenFromIdentifier(identifier: string): string | undefined {
  return identifier.startsWith(TOKEN_IDENTIFIER_PREFIX)
    ? identifier.slice(TOKEN_IDENTIFIER_PREFIX.length)
    : undefined;
}
