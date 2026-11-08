// TEST ONLY. A stand-in for spec 0015's `order-mapper.ts`.
//
// Reads one hand written, SYNTHETIC Shopify Admin GraphQL fixture (synthetic, to be replaced by
// recordings: `src/connectors/shopify/fixtures/`, API version 2026-10) and maps it to the contract
// shapes `ChannelOrderInput` and `ChannelOrderSnapshot` of spec 0013, so the orders intake e2e can
// be driven by Shopify shaped data with no live call. Spec 0015 tasks 4 to 7 build the real mapper
// and a Shopify client; this file is replaced then, and it must never be imported by `src/`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ChannelOrderInput,
  ChannelOrderSnapshot,
  type OrderPaymentMethod,
} from '@ssdashboard/contracts';
import { z } from 'zod';

const FIXTURE_DIR = fileURLToPath(new URL('../src/connectors/shopify/fixtures/', import.meta.url));

const MoneyBag = z.object({ shopMoney: z.object({ amount: z.string() }) });
const TaxLine = z.object({ ratePercentage: z.number().nullable() });
const VisitSchema = z
  .object({
    source: z.string(),
    landingPage: z.string().nullable(),
    referrerUrl: z.string().nullable(),
    utmParameters: z
      .object({
        source: z.string().nullable(),
        medium: z.string().nullable(),
        campaign: z.string().nullable(),
        content: z.string().nullable(),
      })
      .nullable(),
  })
  .nullable();

/** The part of a Shopify `Order` the stand-in mapper reads (a subset of the fixture). */
const ShopifyOrder = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  displayFulfillmentStatus: z.string(),
  paymentGatewayNames: z.array(z.string()),
  totalShippingPriceSet: MoneyBag,
  discountCodes: z.array(z.string()),
  note: z.string().nullable(),
  phone: z.string().nullable(),
  customAttributes: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
  customer: z.object({ id: z.string(), phone: z.string().nullable() }).nullable(),
  shippingAddress: z
    .object({
      name: z.string().nullable(),
      phone: z.string().nullable(),
      address1: z.string().nullable(),
      address2: z.string().nullable(),
      city: z.string().nullable(),
      province: z.string().nullable(),
    })
    .nullable(),
  customerJourneySummary: z.object({ firstVisit: VisitSchema, lastVisit: VisitSchema }).nullable(),
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        variantTitle: z.string().nullable(),
        currentQuantity: z.number().int(),
        variant: z.object({ id: z.string() }).nullable(),
        originalUnitPriceSet: MoneyBag,
        discountAllocations: z.array(z.object({ allocatedAmountSet: MoneyBag })),
        taxLines: z.array(TaxLine),
      }),
    ),
  }),
  fulfillments: z.array(z.object({ id: z.string(), status: z.string(), createdAt: z.string() })),
  transactions: z.array(
    z.object({
      kind: z.string(),
      status: z.string(),
      gateway: z.string().nullable(),
      amountSet: MoneyBag,
    }),
  ),
});
type ShopifyOrder = z.infer<typeof ShopifyOrder>;

const FixtureFile = z.object({
  _fixture: z.object({ synthetic: z.literal(true), apiVersion: z.literal('2026-10') }),
  request: z.object({ shopDomain: z.string() }),
  response: z.object({ body: z.object({ data: z.object({ order: ShopifyOrder }) }) }),
});

/** Where an order of one fixture shop goes in the test database. */
export interface ShopifyShopContext {
  readonly storeId: string;
  readonly channelId: string;
  readonly connectionId: string;
}

/** What the test knows and the real mapper reads from `connection_external_ids` and `config`. */
export interface ShopifyOrderContext {
  /** Fixture shop domain to its store, channel, and connection. */
  readonly shops: Readonly<Record<string, ShopifyShopContext>>;
  /** Shopify variant gid to the app variant id; an absent gid maps to null (an unmapped line). */
  readonly variants: Readonly<Record<string, string>>;
  /** `config.altPhoneAttribute`: the order custom attribute holding the second phone. */
  readonly altPhoneAttribute: string;
}

/** One loaded fixture: the Shopify order and the shop it came from. */
export interface LoadedShopifyOrder {
  readonly shopDomain: string;
  readonly order: ShopifyOrder;
}

/** Options of the mapping. */
export interface ShopifyMapOptions {
  /**
   * Appends a random suffix to the channel ref and the order number, so one fixture can create
   * several orders in one store. Leave it off when the test is about the real ref or number.
   */
  readonly unique?: boolean;
}

/**
 * Gateway name to payment method, the stand-in for spec 0015's `config.gatewayMethods`. Simplified
 * on purpose: an unmapped name is `cod` when the order has no successful transaction on a
 * non cod gateway, else `gateway`.
 */
const GATEWAY_METHODS: Readonly<Record<string, OrderPaymentMethod>> = {
  'Cash on Delivery (COD)': 'cod',
  manual: 'cod',
  'Fixture Card Gateway': 'gateway',
};

/**
 * Reads and validates a fixture, for example `loadShopifyOrder('order-created-cod/01-order-read.json')`.
 * Throws when the file is not a 2026-10 synthetic fixture.
 */
export function loadShopifyOrder(file: string): LoadedShopifyOrder {
  const parsed = FixtureFile.parse(
    JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as unknown,
  );
  return { shopDomain: parsed.request.shopDomain, order: parsed.response.body.data.order };
}

const cents = (amount: string): bigint => {
  const [whole = '0', fraction = ''] = amount.replace('-', '').split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return amount.startsWith('-') ? -value : value;
};
const text = (value: bigint): string => {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

/** Keeps only `utm_` query keys of a link (spec 0002 Follow-up m5), the rest never reach the order. */
function allowListed(link: string | null): string | null {
  if (link === null) return null;
  try {
    const url = new URL(link);
    for (const key of [...url.searchParams.keys()]) {
      if (!key.startsWith('utm_')) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function paymentOf(order: ShopifyOrder): {
  paymentMethod: OrderPaymentMethod;
  prepaidAmount: string;
  prepaidMethod: OrderPaymentMethod | null;
} {
  const methodOf = (gateway: string | null): OrderPaymentMethod | null =>
    gateway === null ? null : (GATEWAY_METHODS[gateway] ?? null);
  let prepaid = 0n;
  let prepaidMethod: OrderPaymentMethod | null = null;
  for (const t of order.transactions) {
    if (t.status !== 'SUCCESS') continue;
    const method = methodOf(t.gateway);
    if (method === 'cod') continue;
    if (t.kind === 'SALE' || t.kind === 'CAPTURE') {
      prepaid += cents(t.amountSet.shopMoney.amount);
      prepaidMethod = method ?? 'gateway';
    } else if (t.kind === 'REFUND') {
      prepaid -= cents(t.amountSet.shopMoney.amount);
    }
  }
  const named = order.paymentGatewayNames.map(methodOf).find((m) => m !== null) ?? null;
  const paymentMethod = named ?? (prepaid > 0n ? 'gateway' : 'cod');
  return prepaid > 0n && prepaidMethod !== null
    ? { paymentMethod, prepaidAmount: text(prepaid), prepaidMethod }
    : { paymentMethod, prepaidAmount: '0.00', prepaidMethod: null };
}

function sharedFields(loaded: LoadedShopifyOrder, context: ShopifyOrderContext) {
  const { order, shopDomain } = loaded;
  const shop = context.shops[shopDomain];
  if (!shop) throw new Error(`No store in the test context for shop ${shopDomain}`);
  const visit =
    order.customerJourneySummary?.lastVisit ?? order.customerJourneySummary?.firstVisit ?? null;
  const address = order.shippingAddress;
  const alt =
    order.customAttributes.find((a) => a.key === context.altPhoneAttribute)?.value ?? null;
  const payment = paymentOf(order);
  return {
    shop,
    payment,
    fields: {
      type: 'sale' as const,
      giftReasonCode: null,
      paymentMethod: payment.paymentMethod,
      shippingChargedAmount: order.totalShippingPriceSet.shopMoney.amount,
      discountCode: order.discountCodes[0] ?? null,
      customerNote: order.note,
      channelCustomer: order.customer
        ? {
            kind: 'shopify_customer' as const,
            connectionId: shop.connectionId,
            externalId: order.customer.id,
          }
        : null,
      source: visit
        ? {
            capturedFrom: 'shopify_journey' as const,
            utmSource: visit.utmParameters?.source ?? null,
            utmMedium: visit.utmParameters?.medium ?? null,
            utmCampaign: visit.utmParameters?.campaign ?? null,
            utmContent: visit.utmParameters?.content ?? null,
            landingPage: allowListed(visit.landingPage),
            referrer: visit.referrerUrl,
          }
        : { capturedFrom: 'none' as const },
      shipTo: {
        name: address?.name ?? null,
        phone: address?.phone ?? order.phone ?? order.customer?.phone ?? null,
        phoneAlt: alt,
        address: address
          ? [address.address1, address.address2, address.city, address.province]
              .filter((part): part is string => !!part)
              .join(', ') || null
          : null,
      },
      lines: order.lineItems.nodes
        .filter((line) => line.currentQuantity > 0)
        .map((line) => ({
          channelLineId: line.id,
          variantId: line.variant ? (context.variants[line.variant.id] ?? null) : null,
          title: [line.title, line.variantTitle].filter(Boolean).join(' '),
          quantity: line.currentQuantity,
          unitPrice: line.originalUnitPriceSet.shopMoney.amount,
          discountAmount: text(
            line.discountAllocations.reduce(
              (sum, d) => sum + cents(d.allocatedAmountSet.shopMoney.amount),
              0n,
            ),
          ),
          taxRate: (line.taxLines[0]?.ratePercentage ?? 0).toFixed(2),
        })),
    },
  };
}

/**
 * The `ChannelOrderInput` a Shopify order becomes: store, channel, and customer from the test
 * context, `channelOrderRef` the order gid, `orderNumber` its name, `placedAt` its creation time,
 * lines by current quantity above 0, prepayment from the successful non cod transactions. No
 * `firstStates` and no `relatedOrder`: see {@link goLiveStates}, {@link foundStates}, and
 * {@link replacementInput}. Parsed with the contract schema.
 */
export function shopifyOrderInput(
  file: string,
  context: ShopifyOrderContext,
  options: ShopifyMapOptions = {},
): ChannelOrderInput {
  const loaded = loadShopifyOrder(file);
  const { shop, payment, fields } = sharedFields(loaded, context);
  const suffix = options.unique ? randomSuffix() : null;
  return ChannelOrderInput.parse({
    storeId: shop.storeId,
    channelId: shop.channelId,
    channelOrderRef: suffix ? `${loaded.order.id}:${suffix}` : loaded.order.id,
    orderNumber: suffix ? `${loaded.order.name}-${suffix}` : loaded.order.name,
    placedAt: loaded.order.createdAt,
    prepaidAmount: payment.prepaidAmount,
    prepaidMethod: payment.prepaidMethod,
    ...fields,
  });
}

/** The `ChannelOrderSnapshot` of a Shopify order: the order as Shopify holds it now. */
export function shopifyOrderSnapshot(
  file: string,
  context: ShopifyOrderContext,
): ChannelOrderSnapshot {
  return ChannelOrderSnapshot.parse(sharedFields(loadShopifyOrder(file), context).fields);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** The go live first states for an order placed before go live (spec 0015 Value sourcing), job actor. */
export function goLiveStates(): { fulfillment: 'confirmed'; reasonCode: 'go_live_import' } {
  return { fulfillment: 'confirmed', reasonCode: 'go_live_import' };
}

/**
 * The states an `import` actor finds a closed order in (spec 0015 Value sourcing): cancelled is
 * `cancelled` with `channel.<reason>`, fulfilled is `shipped` with the first fulfillment's time;
 * cash is `nothing_to_collect` for a cancelled order and `unpaid` otherwise (the first cash rule
 * of a cod order). Returns null for an open order.
 */
export function foundStates(file: string) {
  const { order } = loadShopifyOrder(file);
  if (order.cancelledAt !== null) {
    return {
      fulfillment: 'cancelled' as const,
      cash: 'nothing_to_collect' as const,
      cancelReasonCode: cancelReasonOf(file),
    };
  }
  const first = order.fulfillments.find((f) => f.status === 'SUCCESS');
  if (first) {
    return {
      fulfillment: 'shipped' as const,
      cash: 'unpaid' as const,
      carrierDeliveryCreatedAt: first.createdAt,
    };
  }
  return null;
}

/** The reason code of a Shopify cancellation, `channel.` plus the lower case reason; null if none. */
export function cancelReasonOf(file: string): string | null {
  const { order } = loadShopifyOrder(file);
  return order.cancelReason ? `channel.${order.cancelReason.toLowerCase()}` : null;
}

/** The time of the first successful fulfillment of a fixture order, or null. */
export function firstFulfillmentAt(file: string): string | null {
  return (
    loadShopifyOrder(file).order.fulfillments.find((f) => f.status === 'SUCCESS')?.createdAt ?? null
  );
}

/**
 * The replacement order of an exchange made by editing a delivered order (spec 0015 AC-12): only
 * the line items added since `before`, numbered `<name>-R<n>`, ref `<gid>:R<n>`, no shipping,
 * linked to the original with `replacement_for`.
 */
export function replacementInput(
  before: string,
  after: string,
  originalOrderId: string,
  context: ShopifyOrderContext,
  n = 1,
  options: ShopifyMapOptions = {},
): ChannelOrderInput {
  const known = new Set(loadShopifyOrder(before).order.lineItems.nodes.map((line) => line.id));
  const loaded = loadShopifyOrder(after);
  const { shop, fields } = sharedFields(loaded, context);
  const lines = fields.lines.filter((line) => !known.has(line.channelLineId));
  const suffix = options.unique ? `-${randomSuffix()}` : '';
  return ChannelOrderInput.parse({
    storeId: shop.storeId,
    channelId: shop.channelId,
    channelOrderRef: `${loaded.order.id}:R${n}${suffix}`,
    orderNumber: `${loaded.order.name}-R${n}${suffix}`,
    placedAt: loaded.order.createdAt,
    relatedOrder: { orderId: originalOrderId, relation: 'replacement_for' },
    ...fields,
    shippingChargedAmount: '0.00',
    discountCode: null,
    customerNote: null,
    lines,
  });
}
