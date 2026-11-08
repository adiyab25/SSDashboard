import { z } from 'zod';
import { ReasonCode } from '../orders/order-states.js';
import { defineSetting } from './setting-definition.js';

/**
 * A Shopify tag a gift reason is keyed by (spec 0009, *Rows requested by specs 0012 to 0015*;
 * spec 0015 AC-10): 1 to 40 letters of any script, digits, spaces, and `-_.:/`, with at least one
 * letter, so a tag of digits only (a phone, an order number) never fits. The free text rule of the
 * registry holds every staff typed string to a pattern like this one, because `audit_entries`
 * keeps every value for ever (security review of the settings audit record, finding 1). Accepted
 * by the owner on 2026-11-08, with a check against the pilot brand's real tags before go live.
 */
export const SHOPIFY_GIFT_TAG_PATTERN = /^(?=.*\p{L})[\p{L}\p{N} _.:/-]{1,40}$/u;

/** The most gift tags `shopify_gift_tags` maps. */
export const SHOPIFY_GIFT_TAGS_MAX = 20;

/** One Shopify gift tag. */
const ShopifyGiftTag = z
  .string()
  .regex(SHOPIFY_GIFT_TAG_PATTERN, 'Letters, digits, spaces, and - _ . : /, with a letter');

/**
 * The Policies section of the settings registry (spec 0009, *Policy knobs*, AC-22, AC-31): each
 * knob is changed only by a holder of `settings.manage`, with a reason where the entry says so.
 * The last three are the rows specs 0014 and 0015 request (*Rows requested by specs 0012 to
 * 0015*), exactly as spec 0009's table gives them; nothing reads them until their feature does.
 * Later features add their knobs here in their own build.
 */
export const POLICY_SETTINGS = [
  defineSetting({
    key: 'operations_wind_down_days',
    // Never shorter than the carrier's normal cash window (domain review D8).
    schema: z.number().int().min(60).max(365),
    default: 60,
    bundle: 'operations',
    group: 'policies',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.operationsWindDownDays.label',
    description: 'settings.entries.operationsWindDownDays.description',
  }),
  defineSetting({
    key: 'operations_wind_down_pickup_days',
    // Days after the lapse in which a delivery for an order confirmed before it is followed (D5).
    schema: z.number().int().min(0).max(14),
    default: 3,
    bundle: 'operations',
    group: 'policies',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.operationsWindDownPickupDays.label',
    description: 'settings.entries.operationsWindDownPickupDays.description',
  }),
  defineSetting({
    key: 'customer_risk_signal',
    // When the customer page suggests a risk flag (spec 0014 AC-13): refusals or returns within
    // the window.
    schema: z.strictObject({
      windowDays: z.number().int().min(30).max(730),
      refusalsToSuggest: z.number().int().min(1).max(20),
      returnsToSuggest: z.number().int().min(1).max(20),
    }),
    default: { windowDays: 180, refusalsToSuggest: 2, returnsToSuggest: 2 },
    bundle: 'core',
    group: 'policies',
    whoMayChange: 'settings.manage',
    reason: 'optional',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.customerRiskSignal.label',
    description: 'settings.entries.customerRiskSignal.description',
  }),
  defineSetting({
    key: 'shopify_gift_tags',
    // A Shopify tag to the gift reason an order carrying it is recorded with (spec 0015 AC-10).
    schema: z
      .record(ShopifyGiftTag, ReasonCode)
      .refine(
        (tags) => Object.keys(tags).length <= SHOPIFY_GIFT_TAGS_MAX,
        `At most ${SHOPIFY_GIFT_TAGS_MAX} tags`,
      ),
    default: {},
    bundle: 'core',
    group: 'policies',
    whoMayChange: 'settings.manage',
    reason: 'optional',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.shopifyGiftTags.label',
    description: 'settings.entries.shopifyGiftTags.description',
  }),
  defineSetting({
    key: 'shopify_stock_safety_buffer',
    // Pieces held back from every quantity the stock push sends (spec 0015 AC-19).
    schema: z.number().int().min(0).max(1000),
    default: 0,
    bundle: 'warehouse',
    group: 'policies',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.shopifyStockSafetyBuffer.label',
    description: 'settings.entries.shopifyStockSafetyBuffer.description',
    warning: 'settings.warnings.shopifyStockSafetyBuffer',
  }),
] as const;
