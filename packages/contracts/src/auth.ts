import { z } from 'zod';
import { Hat, Permission } from './access.js';

/**
 * Where a signed in person lands when the sign in page has no valid `returnTo` (spec 0005,
 * AC-28): the back office for staff, the partner pages for a partner user. The api derives it
 * from the audience the person may use; the web never works it out on its own.
 */
export const Home = z.enum(['backoffice', 'partner']);
/** The validated shape of `Home`, as the api and web see it after parsing. */
export type Home = z.infer<typeof Home>;

/**
 * Response of `GET /api/me` (staff) and `GET /api/partner/me` (partner users), one shape for both
 * (spec 0008, AC-11): the signed in person, read fresh from the database on every request. `hats`
 * and `permissions` (the effective list, sorted) tell the web what to show; the api still decides
 * every route on its own. `partnerAccountId` is null for staff and, for a partner user, the
 * account of their own hat row, never anything the request sent; `staffCode` is null for a
 * partner user. There is no role: what a person may do comes only from their hats and grants.
 */
export const MeResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  hats: z.array(Hat),
  permissions: z.array(Permission),
  partnerAccountId: z.uuid().nullable(),
  phone: z.string().nullable(),
  staffCode: z.string().nullable(),
  language: z.string().nullable(),
  twoFactorEnabled: z.boolean(),
  mustChangePassword: z.boolean(),
  home: Home,
});

/** The validated shape of `MeResponse`, as the api and web see it after parsing. */
export type MeResponse = z.infer<typeof MeResponse>;

/** The stable codes the api answers with when a request has no usable session. */
export const SessionErrorCode = z.enum(['UNAUTHENTICATED', 'SESSION_EXPIRED']);
/** The validated shape of `SessionErrorCode`, as the api and web see it after parsing. */
export type SessionErrorCode = z.infer<typeof SessionErrorCode>;

/**
 * The password rule (spec 0005, AC-8): 8 to 128 characters with a lowercase, an uppercase and a
 * digit, any decimal digit (Western, Arabic-Indic, and the rest of Unicode `Nd`).
 */
export const PASSWORD_MIN_LENGTH = 8;
/** Longest password accepted; a cap so hashing cost cannot be abused with huge input. */
export const PASSWORD_MAX_LENGTH = 128;

/** Which rules a password breaks. The forms show the same keys next to each rule. */
export const PasswordRule = z.enum(['min_length', 'max_length', 'lowercase', 'uppercase', 'digit']);
/** The validated shape of `PasswordRule`, as the api and web see it after parsing. */
export type PasswordRule = z.infer<typeof PasswordRule>;

/** Every rule the password breaks, in a stable order. Empty means it is acceptable. */
export function unmetPasswordRules(password: string): PasswordRule[] {
  const unmet: PasswordRule[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) unmet.push('min_length');
  if (password.length > PASSWORD_MAX_LENGTH) unmet.push('max_length');
  if (!/\p{Ll}/u.test(password)) unmet.push('lowercase');
  if (!/\p{Lu}/u.test(password)) unmet.push('uppercase');
  // Any decimal digit counts (Arabic-Indic too); the password is stored and compared as typed.
  if (!/\p{Nd}/u.test(password)) unmet.push('digit');
  return unmet;
}

/** The one schema for a new password: reset, invite, change, and admin issued temporary ones. */
export const Password = z.string().superRefine((value, ctx) => {
  for (const rule of unmetPasswordRules(value)) ctx.addIssue({ code: 'custom', message: rule });
});

/** Body of the 422 `WEAK_PASSWORD` answer. */
export const WeakPasswordResponse = z.object({
  code: z.literal('WEAK_PASSWORD'),
  message: z.string(),
  unmet: z.array(PasswordRule),
});
/** The validated shape of `WeakPasswordResponse`, as the api and web see it after parsing. */
export type WeakPasswordResponse = z.infer<typeof WeakPasswordResponse>;
