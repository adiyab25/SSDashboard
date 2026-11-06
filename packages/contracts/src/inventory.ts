import { z } from 'zod';
import { MoneyString, UnitCostString } from './money.js';
import { ReasonCode } from './orders/order-states.js';

/** What a posting comes from. Matches the `movement_source_type` enum. */
export const LedgerSourceType = z.enum([
  'opening_balance',
  'stock_receipt',
  'purchase_receipt',
  'purchase_return',
  'order_shipment',
  'returned_to_origin_restock',
  'customer_return_restock',
  'exchange_return_restock',
  'consignment_sale',
  'write_off',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'count',
  'production_consume',
  'production_output',
]);
/** The validated shape of `LedgerSourceType`, as the api and web see it after parsing. */
export type LedgerSourceType = z.infer<typeof LedgerSourceType>;

const MAX_INT = 2_147_483_647;
const Uuid = z.uuid();

/** One line of a posting, already in the SKU's base unit. */
export const PostingLine = z.object({
  variantId: Uuid,
  locationId: Uuid,
  binId: Uuid.optional(),
  lotId: Uuid.optional(),
  /** Signed whole units: positive in, negative out. Never zero. */
  quantity: z
    .number()
    .int()
    .min(-MAX_INT)
    .max(MAX_INT)
    .refine((value) => value !== 0, 'Quantity cannot be zero'),
  /** Inbound only: cost per base unit, at most 4 decimals. Rejected on outbound lines. */
  unitCost: UnitCostString.optional(),
  sourceLineId: Uuid.optional(),
  /** Serial tracked SKUs only: exactly as many serials as the absolute quantity. */
  serials: z.array(z.string().trim().min(1).max(200)).optional(),
  /** Outbound only: the reservation this line fulfils. */
  reservationId: Uuid.optional(),
  /** A code (`ReasonCode`, review R7), never a typed note: the movement is kept for ever. */
  reasonCode: ReasonCode.optional(),
});
/** The validated shape of `PostingLine`, as the api and web see it after parsing. */
export type PostingLine = z.infer<typeof PostingLine>;

/** A ledger posting: all its lines commit together or not at all, and `idempotencyKey` makes a retry return the stored result instead of posting twice. */
export const PostingInput = z.object({
  idempotencyKey: z.string().min(1).max(200),
  sourceType: LedgerSourceType,
  sourceId: Uuid,
  /** Defaults to now. May be in the past, never more than 5 minutes ahead. */
  effectiveAt: z.coerce.date().optional(),
  /**
   * Required, never defaulted. Null only for system jobs with no signed in user. HTTP request
   * schemas must omit this field; the controller takes it from the guard's signed in user.
   */
  postedBy: Uuid.nullable(),
  lines: z.array(PostingLine).min(1).max(1000),
});
/** What a caller passes for `PostingInput`, before defaults and transforms are applied. */
export type PostingInput = z.input<typeof PostingInput>;

/**
 * The only schemas an HTTP route may validate a body with; the controller adds postedBy from the
 * signed in user (request.staff.id, see apps/api/src/identity/sign-in/current-staff.ts).
 * `.strict()` rejects any unknown top level key, postedBy included, instead of stripping it; the
 * objects inside `lines` are not strict.
 */
export const PostingRequest = PostingInput.omit({ postedBy: true }).strict();
/** What a caller passes for `PostingRequest`, before defaults and transforms are applied. */
export type PostingRequest = z.input<typeof PostingRequest>;

/** A reversal of a whole posting group. It appends opposite movements; the original rows are never touched. */
export const ReverseInput = z.object({
  groupId: Uuid,
  idempotencyKey: z.string().min(1).max(200),
  effectiveAt: z.coerce.date().optional(),
  /**
   * Required, never defaulted. Null only for system jobs with no signed in user. HTTP request
   * schemas must omit this field; the controller takes it from the guard's signed in user.
   */
  postedBy: Uuid.nullable(),
  /** A code (`ReasonCode`, review R7), for example `wrong_supplier`, never a typed note. */
  reasonCode: ReasonCode,
});
/** What a caller passes for `ReverseInput`, before defaults and transforms are applied. */
export type ReverseInput = z.input<typeof ReverseInput>;

/** The HTTP body for a reversal; see PostingRequest. The controller adds postedBy. */
export const ReverseRequest = ReverseInput.omit({ postedBy: true }).strict();
/** What a caller passes for `ReverseRequest`, before defaults and transforms are applied. */
export type ReverseRequest = z.input<typeof ReverseRequest>;

/** A movement as the ledger stored it, with its unit cost, total cost, and cost variance. */
export const PostedMovement = z.object({
  id: Uuid,
  variantId: Uuid,
  locationId: Uuid,
  binId: Uuid.nullable(),
  lotId: Uuid.nullable(),
  quantity: z.number().int(),
  unitCost: UnitCostString,
  totalCost: MoneyString,
  costVariance: MoneyString,
  costUnknown: z.boolean(),
  sourceLineId: Uuid.nullable(),
  reasonCode: z.string().nullable(),
  serials: z.array(z.string()),
});
/** The validated shape of `PostedMovement`, as the api and web see it after parsing. */
export type PostedMovement = z.infer<typeof PostedMovement>;

/** The stored posting: the same shape on the first call and on every replay of its key. */
export const PostingResult = z.object({
  groupId: Uuid,
  reversesGroupId: Uuid.nullable(),
  sourceType: LedgerSourceType,
  sourceId: Uuid,
  effectiveAt: z.iso.datetime({ offset: true }),
  recordedAt: z.iso.datetime({ offset: true }),
  postedBy: Uuid.nullable(),
  movements: z.array(PostedMovement),
});
/** The validated shape of `PostingResult`, as the api and web see it after parsing. */
export type PostingResult = z.infer<typeof PostingResult>;

/** Filters for reading balances. `cursor` is the last level id of the previous page. */
export const GetLevelsInput = z.object({
  variantId: Uuid.optional(),
  locationId: Uuid.optional(),
  cursor: Uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
/** What a caller passes for `GetLevelsInput`, before defaults and transforms are applied. */
export type GetLevelsInput = z.input<typeof GetLevelsInput>;

/** The running balance of one SKU at one place (location, bin, lot), with its average cost and value. */
export const StockLevel = z.object({
  id: Uuid,
  variantId: Uuid,
  locationId: Uuid,
  binId: Uuid.nullable(),
  lotId: Uuid.nullable(),
  onHand: z.number().int(),
  avgUnitCost: UnitCostString,
  totalValue: MoneyString,
});
/** The validated shape of `StockLevel`, as the api and web see it after parsing. */
export type StockLevel = z.infer<typeof StockLevel>;

/** Per SKU, location, and lot: on hand in sellable bins of a sellable location, less reservations. */
export const Availability = z.object({
  variantId: Uuid,
  locationId: Uuid,
  lotId: Uuid.nullable(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
});
/** The validated shape of `Availability`, as the api and web see it after parsing. */
export type Availability = z.infer<typeof Availability>;

/** One page of balances with their reserved and available figures. */
export const LevelsPage = z.object({
  levels: z.array(StockLevel),
  /** Reserved and available for each SKU, location, and lot on this page. */
  availability: z.array(Availability),
  nextCursor: Uuid.nullable(),
});
/** The validated shape of `LevelsPage`, as the api and web see it after parsing. */
export type LevelsPage = z.infer<typeof LevelsPage>;

/** Filters for the available-to-sell figure of a SKU, optionally at one location. */
export const GetAvailableInput = z.object({
  variantId: Uuid,
  locationId: Uuid.optional(),
});
/** What a caller passes for `GetAvailableInput`, before defaults and transforms are applied. */
export type GetAvailableInput = z.input<typeof GetAvailableInput>;

/** Asks the ledger to hold stock for one document line, keyed by its source document and line. */
export const ReserveInput = z.object({
  variantId: Uuid,
  locationId: Uuid,
  lotId: Uuid.optional(),
  quantity: z.number().int().min(1).max(MAX_INT),
  sourceType: z.string().trim().min(1).max(50),
  sourceId: Uuid,
  sourceLineId: Uuid,
});
/** What a caller passes for `ReserveInput`, before defaults and transforms are applied. */
export type ReserveInput = z.input<typeof ReserveInput>;

/** Releases a reservation, in full or by a partial quantity. */
export const ReleaseInput = z.object({
  reservationId: Uuid,
  /** Partial release; defaults to everything still open. */
  quantity: z.number().int().min(1).max(MAX_INT).optional(),
});
/** What a caller passes for `ReleaseInput`, before defaults and transforms are applied. */
export type ReleaseInput = z.input<typeof ReleaseInput>;

/** Reservation lifecycle: active holds stock, then released (cancelled) or fulfilled (shipped). */
export const ReservationStatus = z.enum(['active', 'released', 'fulfilled']);

/** Stock promised to a document line; `openQuantity` is what is still held. */
export const Reservation = z.object({
  id: Uuid,
  variantId: Uuid,
  locationId: Uuid,
  lotId: Uuid.nullable(),
  quantity: z.number().int(),
  openQuantity: z.number().int(),
  sourceType: z.string(),
  sourceId: Uuid,
  sourceLineId: Uuid,
  status: ReservationStatus,
});
/** The validated shape of `Reservation`, as the api and web see it after parsing. */
export type Reservation = z.infer<typeof Reservation>;
