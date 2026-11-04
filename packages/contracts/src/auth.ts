import { z } from 'zod';

/** Roles until feature 13 replaces them with permissions. */
export const StaffRole = z.enum(['admin', 'staff']);
export type StaffRole = z.infer<typeof StaffRole>;

/** Response of `GET /api/me`: the signed in person, read fresh from the database. */
export const MeResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: StaffRole,
  phone: z.string().nullable(),
  staffCode: z.string().nullable(),
  language: z.string().nullable(),
  twoFactorEnabled: z.boolean(),
  mustChangePassword: z.boolean(),
});

export type MeResponse = z.infer<typeof MeResponse>;

/** The stable codes the api answers with when a request has no usable session. */
export const SessionErrorCode = z.enum(['UNAUTHENTICATED', 'SESSION_EXPIRED']);
export type SessionErrorCode = z.infer<typeof SessionErrorCode>;

/** The password rule (spec 0005, AC-8): 8 to 128 characters with a lowercase, an uppercase and a digit. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Which rules a password breaks. The forms show the same keys next to each rule. */
export const PasswordRule = z.enum(['min_length', 'max_length', 'lowercase', 'uppercase', 'digit']);
export type PasswordRule = z.infer<typeof PasswordRule>;

/** Every rule the password breaks, in a stable order. Empty means it is acceptable. */
export function unmetPasswordRules(password: string): PasswordRule[] {
  const unmet: PasswordRule[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) unmet.push('min_length');
  if (password.length > PASSWORD_MAX_LENGTH) unmet.push('max_length');
  if (!/\p{Ll}/u.test(password)) unmet.push('lowercase');
  if (!/\p{Lu}/u.test(password)) unmet.push('uppercase');
  if (!/\d/.test(password)) unmet.push('digit');
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
export type WeakPasswordResponse = z.infer<typeof WeakPasswordResponse>;
