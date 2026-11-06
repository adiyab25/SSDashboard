import { z } from 'zod';
import { westernDigits } from './digit-input.js';

/**
 * The two access presets the staff screen offers until spec 0008 milestone 2 replaces them with
 * `hats` and `costView` on these contracts (and `PUT /api/staff/:id/access`). It is not stored:
 * the api turns it into hats with the AC-16 mapping (`admin` is `manager` plus the `cost.view`
 * grant, `staff` is `support`, `operations` and `warehouse`), and shows it back as `admin` for a
 * person holding `manager`, else `staff`. Never authorize on it: routes check permissions only.
 */
export const StaffAccessPreset = z.enum(['admin', 'staff']);
/** The validated shape of `StaffAccessPreset`, as the api and web see it after parsing. */
export type StaffAccessPreset = z.infer<typeof StaffAccessPreset>;

/** Derived, never stored: `disabled` when banned, else `invited` until the first sign in. */
export const StaffStatus = z.enum(['invited', 'active', 'disabled']);
/** The validated shape of `StaffStatus`, as the api and web see it after parsing. */
export type StaffStatus = z.infer<typeof StaffStatus>;

/** Field rules (spec 0005, key invariants). All text is trimmed. */
const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

/** A person's display name, 1 to 100 characters. */
export const StaffName = trimmed(1, 100);
/** A sign in email, trimmed and lowercased so lookups and the unique index agree. */
export const StaffEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** Digits, `+` and spaces, 5 to 30 characters; Arabic digits are normalized to Western first (AC-18). */
export const StaffPhone = westernDigits.pipe(
  trimmed(5, 30).regex(/^[0-9+ ]+$/, 'Digits, + and spaces only'),
);
/** Stored uppercase. */
export const StaffCode = trimmed(1, 20).transform((value) => value.toUpperCase());
/** A language code such as `en` or `ar`, 2 to 16 characters. */
export const StaffLanguage = trimmed(2, 16);

/** A row of `GET /api/staff`. */
export const StaffRow = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: StaffAccessPreset,
  status: StaffStatus,
  lastSignInAt: z.string().nullable(),
  twoFactorEnabled: z.boolean(),
});
/** The validated shape of `StaffRow`, as the api and web see it after parsing. */
export type StaffRow = z.infer<typeof StaffRow>;

/** `GET /api/staff/:id`: the row plus what the edit form needs. */
export const StaffDetail = StaffRow.extend({
  phone: z.string().nullable(),
  staffCode: z.string().nullable(),
  language: z.string().nullable(),
  disableReason: z.string().nullable(),
  createdAt: z.string(),
});
/** The validated shape of `StaffDetail`, as the api and web see it after parsing. */
export type StaffDetail = z.infer<typeof StaffDetail>;

/** Query of `GET /api/staff`. `cursor` is the previous page's `nextCursor`. */
export const StaffListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: StaffStatus.optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** The validated shape of `StaffListQuery`, as the api and web see it after parsing. */
export type StaffListQuery = z.infer<typeof StaffListQuery>;

/** One page of `GET /api/staff`; `nextCursor` is null on the last page. */
export const StaffListResponse = z.object({
  rows: z.array(StaffRow),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `StaffListResponse`, as the api and web see it after parsing. */
export type StaffListResponse = z.infer<typeof StaffListResponse>;

/** `POST /api/staff`. */
export const CreateStaffRequest = z.object({
  name: StaffName,
  email: StaffEmail,
  role: StaffAccessPreset,
  phone: StaffPhone.optional(),
  staffCode: StaffCode.optional(),
  language: StaffLanguage.optional(),
});
/** The validated shape of `CreateStaffRequest`, as the api and web see it after parsing. */
export type CreateStaffRequest = z.infer<typeof CreateStaffRequest>;

/** `PATCH /api/staff/:id`. Empty text for phone, staff code or language clears it. */
export const UpdateStaffRequest = z
  .object({
    name: StaffName,
    email: StaffEmail,
    role: StaffAccessPreset,
    phone: StaffPhone.or(z.literal('')).transform((value) => value || null),
    staffCode: StaffCode.or(z.literal('')).transform((value) => value || null),
    language: StaffLanguage.or(z.literal('')).transform((value) => value || null),
  })
  .partial();
/** The validated shape of `UpdateStaffRequest`, as the api and web see it after parsing. */
export type UpdateStaffRequest = z.infer<typeof UpdateStaffRequest>;

/** `POST /api/staff/:id/disable`. */
export const DisableStaffRequest = z.object({ reason: trimmed(1, 300).optional() });
/** The validated shape of `DisableStaffRequest`, as the api and web see it after parsing. */
export type DisableStaffRequest = z.infer<typeof DisableStaffRequest>;

/** How a person gets their first or a new password: by email, or a temporary one shown once. */
export const StaffSetup = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('email') }),
  z.object({ mode: z.literal('temporary_password'), temporaryPassword: z.string() }),
]);
/** The validated shape of `StaffSetup`, as the api and web see it after parsing. */
export type StaffSetup = z.infer<typeof StaffSetup>;

/** Answer to `POST /api/staff`: the new person plus how they get their first password. */
export const CreateStaffResponse = z.object({ staff: StaffDetail, setup: StaffSetup });
/** The validated shape of `CreateStaffResponse`, as the api and web see it after parsing. */
export type CreateStaffResponse = z.infer<typeof CreateStaffResponse>;

/** Answer to a password reset: how the person gets the new password. */
export const ResetStaffPasswordResponse = z.object({ setup: StaffSetup });
/** The validated shape of `ResetStaffPasswordResponse`, as the api and web see it after parsing. */
export type ResetStaffPasswordResponse = z.infer<typeof ResetStaffPasswordResponse>;

/** Answer to revoking a person's sessions: how many were ended. */
export const RevokeSessionsResponse = z.object({ count: z.number().int().nonnegative() });
/** The validated shape of `RevokeSessionsResponse`, as the api and web see it after parsing. */
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
/** The validated shape of `StaffErrorCode`, as the api and web see it after parsing. */
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
/** The validated shape of `UpdateMeRequest`, as the api and web see it after parsing. */
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;
