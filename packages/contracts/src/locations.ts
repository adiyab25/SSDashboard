import { z } from 'zod';
import { LocalizedText } from './localized-text.js';
import { SettlementOwnerType } from './settlement/settlement-enums.js';

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

/** A stored location code: upper case letters, digits, dot, dash, and underscore, up to 16. */
export const LOCATION_CODE_PATTERN = /^[A-Z0-9._-]{1,16}$/;

/** Location codes are trimmed and uppercased before the pattern check (spec 0006, AC-4). */
export const LocationCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(LOCATION_CODE_PATTERN, 'Letters, digits, dot, dash, and underscore, up to 16');

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

/**
 * The location owner type policy shapes (spec 0002 A13, spec 0009 AC-24): the policy enums, twins
 * of the database enums of the same names (`packages/db/test/enum-parity.e2e-spec.ts`), and the
 * `GET` and `PUT /api/inventory/owner-policies` shapes. An instant is UTC with microseconds, the
 * full precision of `updated_at`, so a client sends it back as `expectedUpdatedAt` exactly.
 */
const PolicyInstant = z.iso.datetime({ offset: true });

/** The moment a policy's sale counts. Matches the `sale_recorded_at` database enum. */
export const SaleRecordedAt = z.enum(['at_shipment', 'at_sell_through', 'at_handover']);
/** One `SaleRecordedAt` value. */
export type SaleRecordedAt = z.infer<typeof SaleRecordedAt>;

/** Who refunds: the brand or the location's owner. Matches the `refund_by` enum. */
export const RefundBy = z.enum(['brand', 'location_owner']);
/** One `RefundBy` value. */
export type RefundBy = z.infer<typeof RefundBy>;

/** The tax document a sale needs. Matches the `tax_document` enum. */
export const TaxDocument = z.enum([
  'b2c_electronic_receipt',
  'b2b_electronic_invoice_at_settlement',
  'b2b_electronic_invoice_at_handover',
]);
/** One `TaxDocument` value. */
export type TaxDocument = z.infer<typeof TaxDocument>;

/**
 * The fields of a location owner type policy a manager may send (spec 0009, AC-24): every
 * attribute of the owner type policy row (spec 0002, A13). The five locked fields
 * (`OWNER_POLICY_LOCKED_FIELDS`) change only on a row with no location that is not archived, and
 * never on the brand's own row.
 */
export const OwnerPolicyFields = z.strictObject({
  stockOwnedByBrand: z.boolean(),
  handoverIsSale: z.boolean(),
  saleRecordedAt: SaleRecordedAt,
  endCustomerRefundBy: RefundBy,
  defectivePieceRefundBy: RefundBy,
  taxDocument: TaxDocument,
  settlementOwnerType: SettlementOwnerType.nullable(),
  canSellOnline: z.boolean(),
});
/** The validated shape of `OwnerPolicyFields`. */
export type OwnerPolicyFields = z.infer<typeof OwnerPolicyFields>;

/** A field of a policy row. */
export type OwnerPolicyField = keyof OwnerPolicyFields;

/**
 * The fields whose change would reinterpret stock or sales already recorded at a location of the
 * type (spec 0009, AC-24, D13): locked on the brand's own row always, and on any row with at least
 * one location that is not archived; changed terms mean a new location.
 */
export const OWNER_POLICY_LOCKED_FIELDS = [
  'stockOwnedByBrand',
  'handoverIsSale',
  'saleRecordedAt',
  'taxDocument',
  'settlementOwnerType',
] as const satisfies readonly OwnerPolicyField[];

/**
 * One location owner type policy as `GET /api/inventory/owner-policies` answers it (spec 0009,
 * AC-24, AC-25): the owner type, its attributes, the fields locked right now and the count of
 * locations of the type that are not archived (why they are locked), and when and by whom it last
 * changed (send `updatedAt` back as `expectedUpdatedAt`).
 */
export const OwnerPolicyView = OwnerPolicyFields.extend({
  ownerType: LocationOwnerType,
  lockedFields: z.array(z.enum(OWNER_POLICY_LOCKED_FIELDS)),
  activeLocations: z.int().min(0),
  updatedAt: PolicyInstant,
  updatedBy: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
});
/** The validated shape of `OwnerPolicyView`. */
export type OwnerPolicyView = z.infer<typeof OwnerPolicyView>;

/** Answer of `GET /api/inventory/owner-policies`: every owner type's policy, in enum order. */
export const OwnerPoliciesResponse = z.object({ policies: z.array(OwnerPolicyView) });
/** The validated shape of `OwnerPoliciesResponse`. */
export type OwnerPoliciesResponse = z.infer<typeof OwnerPoliciesResponse>;

/**
 * Body of `PUT /api/inventory/owner-policies/:ownerType` (spec 0009, AC-24): the whole row, the
 * manager's reason, and the `updatedAt` the screen showed (409 `STALE_SETTING` when the row changed
 * since). The reason is required for an edit to succeed, as on the settings and cost rule routes:
 * left out or blank once trimmed, the service answers 422 `REASON_REQUIRED`; at most 500
 * characters. It is optional in the schema only so a missing reason reaches that check rather than
 * the body pipe's generic 422 `VALIDATION_FAILED`.
 */
export const PutOwnerPolicyBody = OwnerPolicyFields.extend({
  reason: z.string().trim().max(500).optional(),
  expectedUpdatedAt: PolicyInstant,
});
/** The validated shape of `PutOwnerPolicyBody`. */
export type PutOwnerPolicyBody = z.infer<typeof PutOwnerPolicyBody>;

/** Answer of the `PUT`: the policy as it now stands, and whether anything was written. */
export const PutOwnerPolicyAnswer = z.object({ policy: OwnerPolicyView, changed: z.boolean() });
/** The validated shape of `PutOwnerPolicyAnswer`. */
export type PutOwnerPolicyAnswer = z.infer<typeof PutOwnerPolicyAnswer>;

/**
 * The stable error codes of the owner policy routes (spec 0009, AC-24): 404
 * `OWNER_TYPE_UNKNOWN`, 422 `OWNER_POLICY_INCONSISTENT` (with `rules`, the broken consistency
 * rules), 409 `OWNER_POLICY_IN_USE` (with `fields`, the locked fields the change touched), 409
 * `SELLABLE_LOCATIONS_EXIST` (online selling turned off while a location of the type sells
 * online), 409 `STALE_SETTING`, 422 `REASON_REQUIRED`, 422 `VALIDATION_FAILED` (a malformed body),
 * and the guard's 403 `FORBIDDEN`.
 */
export const OwnerPolicyErrorCode = z.enum([
  'OWNER_TYPE_UNKNOWN',
  'OWNER_POLICY_INCONSISTENT',
  'OWNER_POLICY_IN_USE',
  'SELLABLE_LOCATIONS_EXIST',
  'STALE_SETTING',
  'REASON_REQUIRED',
  'VALIDATION_FAILED',
  'FORBIDDEN',
]);
/** One owner policy error code. */
export type OwnerPolicyErrorCode = z.infer<typeof OwnerPolicyErrorCode>;
