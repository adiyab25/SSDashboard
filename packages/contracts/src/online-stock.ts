import { z } from 'zod';
import { LocalizedText } from './localized-text.js';

// Online stock and the online gate (spec 0011, milestone 1): what the Shopify connector reads, the
// gate a location passes before it feeds online stock, and the status every staff page shows.

/** The one location that feeds online stock: id, code, and bilingual name (spec 0011 AC-2). */
export const OnlineLocationRef = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
});
/** The validated shape of `OnlineLocationRef`. */
export type OnlineLocationRef = z.infer<typeof OnlineLocationRef>;

/**
 * Answer of `GET /api/stock/online-status` (spec 0011 AC-20): the online location, or null while
 * no location feeds online stock and Shopify is not being updated.
 */
export const OnlineStatusResponse = z.object({ onlineLocation: OnlineLocationRef.nullable() });
/** The validated shape of `OnlineStatusResponse`. */
export type OnlineStatusResponse = z.infer<typeof OnlineStatusResponse>;

/**
 * One variant's online numbers (spec 0011 AC-2): `available` is `onHand - reserved`, `pushable` is
 * `max(onHand - reserved - unfilledDemand, 0)`, the figure a channel may offer.
 */
export const OnlineStockRow = z.object({
  variantId: z.uuid(),
  onHand: z.int(),
  reserved: z.int(),
  unfilledDemand: z.int(),
  available: z.int(),
  pushable: z.int(),
});
/** The validated shape of `OnlineStockRow`. */
export type OnlineStockRow = z.infer<typeof OnlineStockRow>;

/** Largest page and largest variant list of the online reads. */
export const ONLINE_STOCK_PAGE_MAX = 1000;

/** `onlineStock.forVariants` input: 1 to 1,000 variant ids. */
export const OnlineStockVariantIds = z.array(z.uuid()).min(1).max(ONLINE_STOCK_PAGE_MAX);

/** `onlineStock.list` input (spec 0011 AC-3): a keyset page by variant id. */
export const OnlineStockListQuery = z.object({
  afterVariantId: z.uuid().optional(),
  limit: z.int().min(1).max(ONLINE_STOCK_PAGE_MAX).default(500),
});
/** What a caller passes for `OnlineStockListQuery`. */
export type OnlineStockListQuery = z.input<typeof OnlineStockListQuery>;

/** `onlineStock.list` answer: one page and the cursor of the next, or null on the last page. */
export const OnlineStockListResponse = z.object({
  onlineLocationId: z.uuid(),
  rows: z.array(OnlineStockRow),
  nextAfterVariantId: z.uuid().nullable(),
});
/** The validated shape of `OnlineStockListResponse`. */
export type OnlineStockListResponse = z.infer<typeof OnlineStockListResponse>;

/** A UTC instant with microseconds, the full precision of a database timestamp. */
const FeedInstant = z.iso.datetime({ offset: true });

/** The keyset position of a `changedSince` page: the last row's `changedAt` and variant id. */
export const OnlineStockChangedAfter = z.object({
  changedAt: FeedInstant,
  variantId: z.uuid(),
});
/** The validated shape of `OnlineStockChangedAfter`. */
export type OnlineStockChangedAfter = z.infer<typeof OnlineStockChangedAfter>;

/** `onlineStock.changedSince` input (spec 0011 AC-4); `since` null reads every row. */
export const OnlineStockChangedSinceQuery = z.object({
  since: FeedInstant.nullable(),
  after: OnlineStockChangedAfter.optional(),
  limit: z.int().min(1).max(ONLINE_STOCK_PAGE_MAX).default(500),
});
/** What a caller passes for `OnlineStockChangedSinceQuery`. */
export type OnlineStockChangedSinceQuery = z.input<typeof OnlineStockChangedSinceQuery>;

/** One changed variant: its numbers and when they last changed. */
export const OnlineStockChangedRow = OnlineStockRow.extend({ changedAt: FeedInstant });
/** The validated shape of `OnlineStockChangedRow`. */
export type OnlineStockChangedRow = z.infer<typeof OnlineStockChangedRow>;

/**
 * `onlineStock.changedSince` answer: `watermark` is the database time minus five minutes; store the
 * first page's watermark as the next `since`.
 */
export const OnlineStockChangedSinceResponse = z.object({
  onlineLocationId: z.uuid(),
  watermark: FeedInstant,
  rows: z.array(OnlineStockChangedRow),
  nextAfter: OnlineStockChangedAfter.nullable(),
});
/** The validated shape of `OnlineStockChangedSinceResponse`. */
export type OnlineStockChangedSinceResponse = z.infer<typeof OnlineStockChangedSinceResponse>;

/** `onlineStock.forCandidate` input: optionally the variants to read, else a keyset page. */
export const OnlineStockCandidateQuery = z.object({
  variantIds: OnlineStockVariantIds.optional(),
  afterVariantId: z.uuid().optional(),
  limit: z.int().min(1).max(ONLINE_STOCK_PAGE_MAX).default(500),
});
/** What a caller passes for `OnlineStockCandidateQuery`. */
export type OnlineStockCandidateQuery = z.input<typeof OnlineStockCandidateQuery>;

/** `onlineStock.forCandidate` answer: the numbers at a location that is not necessarily online. */
export const OnlineStockCandidateResponse = z.object({
  locationId: z.uuid(),
  rows: z.array(OnlineStockRow),
  nextAfterVariantId: z.uuid().nullable(),
});
/** The validated shape of `OnlineStockCandidateResponse`. */
export type OnlineStockCandidateResponse = z.infer<typeof OnlineStockCandidateResponse>;

/**
 * A same origin api path a gate action may point at: `/api/` then letters, digits, `-`, `_` and
 * `/` only, so never another host (`https://`, `//host`), a `..` segment, a query, or a fragment.
 * The web fetches or links this path as it is, so a provider can never send a browser off site.
 */
export const GATE_ACTION_PATH = /^(?!.*\/\/)\/api\/[A-Za-z0-9/_-]+$/;

/** The route a failed gate check points to: the HTTP method and path that fixes it, with a label key. */
export const OnlineGateAction = z.object({
  method: z.enum(['POST', 'PUT', 'PATCH']),
  path: z.string().regex(GATE_ACTION_PATH, 'A gate action path is a same origin /api/ path'),
  /** A `@ssdashboard/i18n` message key; the web translates it. */
  label: z.string().min(1),
});
/** The validated shape of `OnlineGateAction`. */
export type OnlineGateAction = z.infer<typeof OnlineGateAction>;

/**
 * One check of the online gate (spec 0011 AC-19). `key` is owned by the module that registered
 * it; `label` is a `@ssdashboard/i18n` message key, never display text; `count` is the check's own
 * number to show (items the check looked at); `action` is the route that fixes a failed check.
 */
export const OnlineGateCheck = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  passed: z.boolean(),
  count: z.int().min(0),
  action: OnlineGateAction.optional(),
});
/** The validated shape of `OnlineGateCheck`. */
export type OnlineGateCheck = z.infer<typeof OnlineGateCheck>;

/** The key of the gate's own check: the location's stock is confirmed counted. */
export const STOCK_COUNTED_CHECK_KEY = 'stock_counted';

/** Answer of `GET /api/locations/:id/online-gate` (spec 0011 AC-19). */
export const OnlineGateView = z.object({
  canGoOnline: z.boolean(),
  checks: z.array(OnlineGateCheck),
  /** Variants with a positive on hand at the location: the figure `make-online` must confirm. */
  variantsWithStock: z.int().min(0),
  totalOnHand: z.int(),
  /** Variants with a balance or reservation there that will be pushed as 0. */
  variantsPushedZero: z.int().min(0),
  /** Active reservations at the current online location, which stay there after the move. */
  reservationsAtOldLocation: z.int().min(0),
  currentOnlineLocation: OnlineLocationRef.nullable(),
});
/** The validated shape of `OnlineGateView`. */
export type OnlineGateView = z.infer<typeof OnlineGateView>;

/**
 * Body of `POST /api/locations/:id/make-online`: the variant count the manager saw
 * (409 `ONLINE_GATE_STALE` when it changed) and the written reason (422 `REASON_REQUIRED` when
 * missing or blank; it is optional in the schema so a blank reaches that check).
 */
export const MakeLocationOnlineRequest = z
  .object({
    confirmedVariantCount: z.int().min(0),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
/** What a caller passes for `MakeLocationOnlineRequest`. */
export type MakeLocationOnlineRequest = z.input<typeof MakeLocationOnlineRequest>;

/** Body of `POST /api/locations/online/stop`: the written reason (422 `REASON_REQUIRED` when blank). */
export const StopOnlineRequest = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
/** What a caller passes for `StopOnlineRequest`. */
export type StopOnlineRequest = z.input<typeof StopOnlineRequest>;

/** Answer of `POST /api/locations/online/stop`. */
export const StopOnlineResponse = z.object({ onlineLocation: z.null() });
/** The validated shape of `StopOnlineResponse`. */
export type StopOnlineResponse = z.infer<typeof StopOnlineResponse>;

/** Body of `POST /api/locations/:id/confirm-stock`: an optional written note. */
export const ConfirmLocationStockRequest = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
/** What a caller passes for `ConfirmLocationStockRequest`. */
export type ConfirmLocationStockRequest = z.input<typeof ConfirmLocationStockRequest>;
