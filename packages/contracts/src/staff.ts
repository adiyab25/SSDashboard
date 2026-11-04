import { z } from 'zod';
import { StaffRole } from './auth.js';

/** Derived, never stored: `disabled` when banned, else `invited` until the first sign in. */
export const StaffStatus = z.enum(['invited', 'active', 'disabled']);
export type StaffStatus = z.infer<typeof StaffStatus>;

/** Field rules (spec 0005, key invariants). All text is trimmed. */
const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const StaffName = trimmed(1, 100);
export const StaffEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** Digits, `+` and spaces, 5 to 30 characters. */
export const StaffPhone = trimmed(5, 30).regex(/^[0-9+ ]+$/, 'Digits, + and spaces only');
/** Stored uppercase. */
export const StaffCode = trimmed(1, 20).transform((value) => value.toUpperCase());
export const StaffLanguage = trimmed(2, 16);

/** A row of `GET /api/staff`. */
export const StaffRow = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: StaffRole,
  status: StaffStatus,
  lastSignInAt: z.string().nullable(),
  twoFactorEnabled: z.boolean(),
});
export type StaffRow = z.infer<typeof StaffRow>;

/** `GET /api/staff/:id`: the row plus what the edit form needs. */
export const StaffDetail = StaffRow.extend({
  phone: z.string().nullable(),
  staffCode: z.string().nullable(),
  language: z.string().nullable(),
  disableReason: z.string().nullable(),
  createdAt: z.string(),
});
export type StaffDetail = z.infer<typeof StaffDetail>;

/** Query of `GET /api/staff`. `cursor` is the previous page's `nextCursor`. */
export const StaffListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: StaffStatus.optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type StaffListQuery = z.infer<typeof StaffListQuery>;

export const StaffListResponse = z.object({
  rows: z.array(StaffRow),
  nextCursor: z.string().nullable(),
});
export type StaffListResponse = z.infer<typeof StaffListResponse>;

/** `POST /api/staff`. */
export const CreateStaffRequest = z.object({
  name: StaffName,
  email: StaffEmail,
  role: StaffRole,
  phone: StaffPhone.optional(),
  staffCode: StaffCode.optional(),
  language: StaffLanguage.optional(),
});
export type CreateStaffRequest = z.infer<typeof CreateStaffRequest>;

/** `PATCH /api/staff/:id`. Empty text for phone, staff code or language clears it. */
export const UpdateStaffRequest = z
  .object({
    name: StaffName,
    email: StaffEmail,
    role: StaffRole,
    phone: StaffPhone.or(z.literal('')).transform((value) => value || null),
    staffCode: StaffCode.or(z.literal('')).transform((value) => value || null),
    language: StaffLanguage.or(z.literal('')).transform((value) => value || null),
  })
  .partial();
export type UpdateStaffRequest = z.infer<typeof UpdateStaffRequest>;

/** `POST /api/staff/:id/disable`. */
export const DisableStaffRequest = z.object({ reason: trimmed(1, 300).optional() });
export type DisableStaffRequest = z.infer<typeof DisableStaffRequest>;

/** How a person gets their first or a new password: by email, or a temporary one shown once. */
export const StaffSetup = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('email') }),
  z.object({ mode: z.literal('temporary_password'), temporaryPassword: z.string() }),
]);
export type StaffSetup = z.infer<typeof StaffSetup>;

export const CreateStaffResponse = z.object({ staff: StaffDetail, setup: StaffSetup });
export type CreateStaffResponse = z.infer<typeof CreateStaffResponse>;

export const ResetStaffPasswordResponse = z.object({ setup: StaffSetup });
export type ResetStaffPasswordResponse = z.infer<typeof ResetStaffPasswordResponse>;

export const RevokeSessionsResponse = z.object({ count: z.number().int().nonnegative() });
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponse>;

/** The stable codes `/api/staff` answers with, besides the shared ones. */
export const StaffErrorCode = z.enum([
  'FORBIDDEN',
  'EMAIL_TAKEN',
  'STAFF_CODE_TAKEN',
  'EMAIL_LOCKED',
  'LAST_ADMIN',
  'SELF_DISABLE',
  'SELF_ACTION',
  'NOT_INVITED',
  'MAIL_DISABLED',
  'INVALID_LANGUAGE',
  'NOT_FOUND',
]);
export type StaffErrorCode = z.infer<typeof StaffErrorCode>;

/**
 * `PATCH /api/me` (spec 0005, AC-19): a person edits their own name, phone and language. Empty
 * text clears a phone or a language. Email, role and staff code are not here on purpose, and any
 * other field is refused rather than ignored, so an attempt to change them is never silent.
 */
export const UpdateMeRequest = z
  .object({
    name: StaffName,
    phone: StaffPhone.or(z.literal('')).transform((value) => value || null),
    language: StaffLanguage.or(z.literal('')).transform((value) => value || null),
  })
  .partial()
  .strict();
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;
