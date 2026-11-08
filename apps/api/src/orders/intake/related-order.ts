import type {
  FulfillmentState,
  OrderRelation,
  OrderType,
  RelatedOrderInput,
  RelatedOrderRelation,
} from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import type { OrderTransaction } from '../order-transactions.js';
import { AlreadyReopened, RelatedOrderState, RelatedOrderUnknown } from '../orders.errors.js';
import type { OrderSourceColumns } from '../writer/order-writer.js';

/** An original in one of these states may be reopened (`reopened_from`, spec 0013 AC-23). */
export const REOPENABLE_STATES: readonly FulfillmentState[] = [
  'cancelled',
  'refused',
  'returned_to_origin',
  'lost',
];

/** An original in one of these states may get a replacement (`replacement_for`). */
export const REPLACEABLE_STATES: readonly FulfillmentState[] = [
  'refused',
  'delivered',
  'partially_delivered',
];

/** What a link to an earlier order decides for the new order's columns. */
export interface RelatedOrderPlan {
  /** `exchange_replacement` for `replacement_for`, else the order's own type. */
  type: OrderType;
  originalOrderId: string | null;
  relatedOrderId: string | null;
  relatedOrderRelation: OrderRelation | null;
  /** The relation as asked, for the audit entry and the `OrderPlaced` event. */
  asked: RelatedOrderRelation;
  /** The customer the original belongs to (as stored: the caller resolves her to the canonical one). */
  originalCustomerId: string | null;
  /** The original's campaign and discount code, copied by `reopened_from`. */
  copied: { source: OrderSourceColumns; discountCode: string | null } | null;
}

interface OriginalRow extends Record<string, unknown> {
  id: string;
  customer_id: string | null;
  fulfillment_state: FulfillmentState;
  discount_code: string | null;
  source_captured_from: OrderSourceColumns['capturedFrom'];
  source_campaign_id: string | null;
  source_adset_id: string | null;
  source_ad_id: string | null;
  source_utm_source: string | null;
  source_utm_medium: string | null;
  source_utm_campaign: string | null;
  source_utm_content: string | null;
  source_landing_page: string | null;
  source_referrer: string | null;
  source_media_buyer_id: string | null;
  source_influencer_code: string | null;
}

/**
 * Reads the original of a link under its row lock and decides how the new order is linked
 * (spec 0013 AC-23, Value sourcing): `reopened_from` needs a `cancelled`, `refused`,
 * `returned_to_origin`, or `lost` original and copies its campaign and discount code;
 * `replacement_for` needs a `refused`, `delivered`, or `partially_delivered` original and makes
 * the new order an `exchange_replacement` (the exchange stays null until feature 34);
 * `goodwill_for` takes any original. Throws `RelatedOrderUnknown` for an unknown original and
 * `RelatedOrderState` for a state the relation does not accept. Returns null without a link.
 */
export async function planRelatedOrder(
  tx: OrderTransaction,
  link: RelatedOrderInput | null | undefined,
  ownType: OrderType,
): Promise<RelatedOrderPlan | null> {
  if (!link) return null;
  const { rows } = await tx.execute<OriginalRow>(sql`
    SELECT id, customer_id, fulfillment_state, discount_code, source_captured_from, source_campaign_id,
           source_adset_id, source_ad_id, source_utm_source, source_utm_medium,
           source_utm_campaign, source_utm_content, source_landing_page, source_referrer,
           source_media_buyer_id, source_influencer_code
    FROM orders WHERE id = ${link.orderId}::uuid FOR UPDATE`);
  const original = rows[0];
  if (!original) throw new RelatedOrderUnknown();
  switch (link.relation) {
    case 'reopened_from':
      if (!REOPENABLE_STATES.includes(original.fulfillment_state)) throw new RelatedOrderState();
      return {
        type: ownType,
        originalOrderId: null,
        relatedOrderId: original.id,
        relatedOrderRelation: 'reopened_from',
        asked: link.relation,
        originalCustomerId: original.customer_id,
        copied: {
          discountCode: original.discount_code,
          source: {
            capturedFrom: original.source_captured_from,
            campaignId: original.source_campaign_id,
            adsetId: original.source_adset_id,
            adId: original.source_ad_id,
            utmSource: original.source_utm_source,
            utmMedium: original.source_utm_medium,
            utmCampaign: original.source_utm_campaign,
            utmContent: original.source_utm_content,
            landingPage: original.source_landing_page,
            referrer: original.source_referrer,
            mediaBuyerId: original.source_media_buyer_id,
            influencerCode: original.source_influencer_code,
          },
        },
      };
    case 'replacement_for':
      if (!REPLACEABLE_STATES.includes(original.fulfillment_state)) throw new RelatedOrderState();
      return {
        type: 'exchange_replacement',
        originalOrderId: original.id,
        relatedOrderId: null,
        relatedOrderRelation: null,
        asked: link.relation,
        originalCustomerId: original.customer_id,
        copied: null,
      };
    case 'goodwill_for':
      return {
        type: ownType,
        originalOrderId: null,
        relatedOrderId: original.id,
        relatedOrderRelation: 'goodwill_for',
        asked: link.relation,
        originalCustomerId: original.customer_id,
        copied: null,
      };
  }
}

/**
 * An order may be reopened once, whatever became of the reopened order (security S2 and the
 * owner's ruling during milestone 2: one reopen per original, whatever its outcome). Refuses
 * with `AlreadyReopened` when any order already
 * points at `originalOrderId` with `reopened_from`, in any state and with any outcome, cancelled
 * included. The caller holds the original's row lock (taken by `planRelatedOrder`), so two
 * reopens at once cannot both pass; `orders_related_order_idx` serves the lookup.
 */
export async function assertNotReopened(
  tx: OrderTransaction,
  originalOrderId: string,
): Promise<void> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM orders
    WHERE related_order_id = ${originalOrderId}::uuid
      AND related_order_relation = 'reopened_from'
    LIMIT 1`);
  if (rows.length > 0) throw new AlreadyReopened();
}
