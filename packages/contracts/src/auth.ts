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
