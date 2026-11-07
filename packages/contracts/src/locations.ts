import { z } from 'zod';
import { LocalizedText } from './localized-text.js';

/** Location lifecycle: active, or archived instead of deleted. */
export const LocationStatus = z.enum(['active', 'archived']);
/** The validated shape of `LocationStatus`, as the api and web see it after parsing. */
export type LocationStatus = z.infer<typeof LocationStatus>;

/**
 * Query of `GET /api/locations`. `cursor` is the previous page's `nextCursor`. `status=archived`
 * needs `catalog.manage` too (403 `FORBIDDEN` without it).
 */
export const LocationListQuery = z.object({
  status: LocationStatus.default('active'),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});

/** The validated shape of `LocationListQuery`, as the api and web see it after parsing. */
export type LocationListQuery = z.infer<typeof LocationListQuery>;

/** The places a person works in: warehouses and shops, never transit or virtual ones. */
export const WorkLocationKind = z.enum(['warehouse', 'shop']);
/** The validated shape of `WorkLocationKind`, as the api and web see it after parsing. */
export type WorkLocationKind = z.infer<typeof WorkLocationKind>;

/**
 * Who owns a location (spec 0002, A13). Fixed for the location's life. Only the api's
 * `LocationPolicyService` may branch on a value; everything else asks it for the policy.
 */
export const LocationOwnerType = z.enum(['own', 'consignment_partner', 'wholesale_customer']);
/** The validated shape of `LocationOwnerType`, as the api and web see it after parsing. */
export type LocationOwnerType = z.infer<typeof LocationOwnerType>;

/** A location as a picker shows it: id, code, bilingual name, kind, owner type, and whether it feeds online channels. */
export const LocationSummary = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
  kind: WorkLocationKind,
  /** Read only: set when the location is created and never changed. */
  ownerType: LocationOwnerType,
  sellableOnline: z.boolean(),
});

/** The validated shape of `LocationSummary`, as the api and web see it after parsing. */
export type LocationSummary = z.infer<typeof LocationSummary>;

/** Location codes are trimmed and uppercased before the pattern check (spec 0006, AC-4). */
export const LocationCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9._-]{1,16}$/, 'Letters, digits, dot, dash, and underscore, up to 16');

const LocationNameText = z.string().trim().min(1).max(200);

/** A location name in English and/or Arabic: at least one language. Empty strings count as absent. */
export const LocationName = z
  .object({
    en: LocationNameText.optional().or(z.literal('').transform(() => undefined)),
    ar: LocationNameText.optional().or(z.literal('').transform(() => undefined)),
  })
  .refine((name) => name.en !== undefined || name.ar !== undefined, {
    message: 'Give a name in at least one language',
    path: ['en'],
  });

/**
 * `POST /api/locations` (`catalog.manage`). `ownerType` defaults to `own`; a partner or wholesale owner
 * needs the `partyId` of a party with the matching role (422 `PARTY_ROLE_MISMATCH`), and an own
 * location takes none. `sellableOnline` defaults to false and is refused where the owner type's
 * policy forbids it (422 `NOT_SELLABLE_ONLINE`).
 */
export const CreateLocationRequest = z
  .object({
    code: LocationCode,
    name: LocationName,
    kind: WorkLocationKind,
    ownerType: LocationOwnerType.optional(),
    partyId: z.uuid().optional(),
    sellableOnline: z.boolean().optional(),
  })
  .strict();
/** What a caller passes for `CreateLocationRequest`, before defaults and transforms are applied. */
export type CreateLocationRequest = z.input<typeof CreateLocationRequest>;

/** One location as the list and the management endpoints return it. */
export const LocationDetail = LocationSummary.extend({
  archived: z.boolean(),
  /** The microsecond UTC string the stale check compares. */
  updatedAt: z.string(),
  /** True once stock was posted or a receipt was recorded there: the code is read only. */
  codeLocked: z.boolean(),
});
/** The validated shape of `LocationDetail`, as the api and web see it after parsing. */
export type LocationDetail = z.infer<typeof LocationDetail>;

/** Warehouses and shops ordered by code, a page at a time. Never transit or virtual. */
export const LocationListResponse = z.object({
  items: z.array(LocationDetail),
  nextCursor: z.string().nullable(),
});

/** The validated shape of `LocationListResponse`, as the api and web see it after parsing. */
export type LocationListResponse = z.infer<typeof LocationListResponse>;

/**
 * `PATCH /api/locations/:id` (`catalog.manage`). Absent fields are left as is. A code change answers 409
 * `CODE_LOCKED` once `codeLocked` is true; a stale `updatedAt` answers 409 `STALE_RECORD`.
 */
export const UpdateLocationRequest = z
  .object({
    updatedAt: z.string().min(1).max(40),
    code: LocationCode.optional(),
    name: LocationName.optional(),
    kind: WorkLocationKind.optional(),
    sellableOnline: z.boolean().optional(),
  })
  .strict();
/** What a caller passes for `UpdateLocationRequest`, before defaults and transforms are applied. */
export type UpdateLocationRequest = z.input<typeof UpdateLocationRequest>;
