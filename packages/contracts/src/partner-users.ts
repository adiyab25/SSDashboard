import { z } from 'zod';
import { AccessReason } from './access.js';
import {
  StaffEmail,
  StaffLanguage,
  StaffName,
  StaffPhone,
  StaffSetup,
  StaffStatus,
} from './staff.js';

// Spec 0008 AC-15: the logins of consignment partners, run by a person with `people.manage` under
// `/api/partner-users` (staff audience). A partner user wears the `partner` hat only, is bound to
// exactly one partner account (a `parties` row that is a consignment partner), and never sees
// cost. The field rules are the staff ones (spec 0005): one person, one set of rules.

/**
 * A partner account a partner user can be bound to (`GET /api/partner-users/partner-accounts`):
 * a consignment partner's id, code and name, nothing more (never its contact details).
 */
export const PartnerAccount = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
});
/** The validated shape of `PartnerAccount`, as the api and web see it after parsing. */
export type PartnerAccount = z.infer<typeof PartnerAccount>;

/** Answer to `GET /api/partner-users/partner-accounts`: every consignment partner, by code. */
export const PartnerAccountsResponse = z.array(PartnerAccount);
/** The validated shape of `PartnerAccountsResponse`, as the api and web see it after parsing. */
export type PartnerAccountsResponse = z.infer<typeof PartnerAccountsResponse>;

/**
 * A row of `GET /api/partner-users`: the person, the partner account they are bound to, and the
 * derived status. There are no hats (always `partner`) and no cost flag (never).
 */
export const PartnerUserRow = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  partnerAccountId: z.uuid(),
  status: StaffStatus,
  lastSignInAt: z.string().nullable(),
  twoFactorEnabled: z.boolean(),
});
/** The validated shape of `PartnerUserRow`, as the api and web see it after parsing. */
export type PartnerUserRow = z.infer<typeof PartnerUserRow>;

/**
 * `GET /api/partner-users/:id`, and the answer of every change: the row plus what the edit form
 * needs. `updatedAt` is `users.updated_at` to the microsecond, sent back unchanged as the
 * `updatedAt` of `PUT /api/partner-users/:id/access` (409 `STALE_RECORD` when it moved on).
 */
export const PartnerUserDetail = PartnerUserRow.extend({
  phone: z.string().nullable(),
  language: z.string().nullable(),
  disableReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** The validated shape of `PartnerUserDetail`, as the api and web see it after parsing. */
export type PartnerUserDetail = z.infer<typeof PartnerUserDetail>;

/**
 * Query of `GET /api/partner-users`. `partnerAccountId` keeps the logins of one partner account;
 * `cursor` is the previous page's `nextCursor`.
 */
export const PartnerUserListQuery = z.object({
  partnerAccountId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  status: StaffStatus.optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** The validated shape of `PartnerUserListQuery`, as the api and web see it after parsing. */
export type PartnerUserListQuery = z.infer<typeof PartnerUserListQuery>;

/** One page of `GET /api/partner-users`; `nextCursor` is null on the last page. */
export const PartnerUserListResponse = z.object({
  rows: z.array(PartnerUserRow),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `PartnerUserListResponse`, as the api and web see it after parsing. */
export type PartnerUserListResponse = z.infer<typeof PartnerUserListResponse>;

/**
 * `POST /api/partner-users`: the person's details and the partner account they sign in for. The
 * api gives the `partner` hat and nothing else; an unknown account, or a party that is not a
 * consignment partner, is 422 `UNKNOWN_PARTNER_ACCOUNT`.
 */
export const CreatePartnerUserRequest = z.object({
  name: StaffName,
  email: StaffEmail,
  partnerAccountId: z.uuid(),
  phone: StaffPhone.optional(),
  language: StaffLanguage.optional(),
});
/** The validated shape of `CreatePartnerUserRequest`, as the api and web see it after parsing. */
export type CreatePartnerUserRequest = z.infer<typeof CreatePartnerUserRequest>;

/** Answer to `POST /api/partner-users`: the new login plus how the person gets their first password. */
export const CreatePartnerUserResponse = z.object({
  partnerUser: PartnerUserDetail,
  setup: StaffSetup,
});
/** The validated shape of `CreatePartnerUserResponse`, as the api and web see it after parsing. */
export type CreatePartnerUserResponse = z.infer<typeof CreatePartnerUserResponse>;

/**
 * `PATCH /api/partner-users/:id`: details only. Empty text for phone or language clears it. The
 * partner account changes only through `PUT /api/partner-users/:id/access`; any other field is
 * refused rather than ignored.
 */
export const UpdatePartnerUserRequest = z
  .object({
    name: StaffName,
    email: StaffEmail,
    phone: StaffPhone.or(z.literal('')).transform((value) => value || null),
    language: StaffLanguage.or(z.literal('')).transform((value) => value || null),
  })
  .partial()
  .strict();
/** The validated shape of `UpdatePartnerUserRequest`, as the api and web see it after parsing. */
export type UpdatePartnerUserRequest = z.infer<typeof UpdatePartnerUserRequest>;

/**
 * `PUT /api/partner-users/:id/access` (spec 0008, AC-12): binds the partner user to another
 * partner account. `updatedAt` is the detail's `updatedAt` read before (409 `STALE_RECORD` on a
 * mismatch); the move ends every session of the person in the same transaction (spec 0005 AC-33
 * b). `reason` is optional, up to 500 characters.
 */
export const PartnerAccessRequest = z.object({
  partnerAccountId: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
  reason: AccessReason.optional(),
});
/** The validated shape of `PartnerAccessRequest`, as the api and web see it after parsing. */
export type PartnerAccessRequest = z.infer<typeof PartnerAccessRequest>;

/** The stable codes `/api/partner-users` answers with, besides the shared ones. */
export const PartnerUserErrorCode = z.enum([
  'FORBIDDEN',
  'NOT_FOUND',
  'EMAIL_TAKEN',
  'EMAIL_LOCKED',
  'SELF_ACTION',
  'NOT_INVITED',
  'MAIL_DISABLED',
  'INVALID_LANGUAGE',
  'STALE_RECORD',
  'UNKNOWN_PARTNER_ACCOUNT',
  'COST_HOLDER_PROTECTED',
]);
/** The validated shape of `PartnerUserErrorCode`, as the api and web see it after parsing. */
export type PartnerUserErrorCode = z.infer<typeof PartnerUserErrorCode>;
