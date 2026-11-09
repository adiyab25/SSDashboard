// The one Shopify order mapper (spec 0015 AC-7, AC-9, AC-10, AC-12, AC-13, Inbound processing item
// 4, Value sourcing). Pure: no database, no clock, no log, no Shopify call. The inbox job reads the
// order back with `ORDER_READ`, parses it with `parseShopifyOrder`, gathers the context from its
// own rows and settings, and hands the result to `OrderIntake` (spec 0013). Law 151: nothing here
// logs, and no thrown message carries a name, phone, address, note, or any other read value.
import {
  ChannelOrderInput,
  ChannelOrderSnapshot,
  GiftReasonCode,
  ImportFirstStates,
  Money,
  ReasonCode,
  type GoLiveFirstStates,
  type OrderPaymentMethod,
  type RederivePaymentMethodInput,
} from '@ssdashboard/contracts';
import { z, type ZodType } from 'zod';
import {
  ORDER_READ_FULFILLMENTS_PAGE,
  ORDER_READ_TAX_LINES_PAGE,
  ORDER_READ_TRANSACTIONS_PAGE,
} from './shopify-queries.js';
import { isStorableText, StorableShopifyId, withoutLoneSurrogates } from './storable-text.js';

// ---------------------------------------------------------------------------------------------
// The Shopify `Order` shape `ORDER_READ` selects (Admin GraphQL `2026-10`)
// ---------------------------------------------------------------------------------------------

/** A `MoneyBag` read for its shop currency amount only (`Decimal`, serialized as a string). */
const MoneyBag = z.object({ shopMoney: z.object({ amount: z.string() }) });

const PageInfo = z.object({ hasNextPage: z.boolean() });

/**
 * A Shopify `DateTime` as an ISO 8601 instant with its offset (security review L3): a value that
 * is not one fails the read as `ORDER_UNREADABLE` instead of reaching a SQL cast or `new Date`.
 */
const Instant = z.iso.datetime({ offset: true });

const Visit = z
  .object({
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

/**
 * The part of a Shopify `Order` the mapper reads, field for field what `ORDER_READ` selects
 * (`shopify-queries.ts`). Unknown keys are stripped, so a recording holding more fields parses.
 * Enum fields (`cancelReason`, `status`, `kind`, `targetType`) are plain strings on purpose: a
 * value Shopify adds later must not fail the read, the mapper decides what it means.
 */
export const ShopifyOrder = z.object({
  id: StorableShopifyId,
  name: z.string().min(1),
  createdAt: Instant,
  updatedAt: Instant,
  test: z.boolean(),
  cancelledAt: Instant.nullable(),
  cancelReason: z.string().nullable(),
  paymentGatewayNames: z.array(z.string()),
  totalPriceSet: MoneyBag,
  currentTotalPriceSet: MoneyBag,
  totalShippingPriceSet: MoneyBag,
  discountCodes: z.array(z.string()),
  discountApplications: z.object({
    nodes: z.array(
      z.object({
        __typename: z.string(),
        targetType: z.string(),
        code: z.string().optional(),
      }),
    ),
    pageInfo: PageInfo,
  }),
  note: z.string().nullable(),
  phone: z.string().nullable(),
  tags: z.array(z.string()),
  customAttributes: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
  customer: z
    .object({
      id: StorableShopifyId,
      defaultPhoneNumber: z.object({ phoneNumber: z.string() }).nullable(),
      /** Deprecated on `2026-10` (carry-over D4): read only when `defaultPhoneNumber` is null. */
      phone: z.string().nullable(),
    })
    .nullable(),
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
  customerJourneySummary: z.object({ firstVisit: Visit, lastVisit: Visit }).nullable(),
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id: StorableShopifyId,
        title: z.string(),
        variantTitle: z.string().nullable(),
        currentQuantity: z.number().int(),
        /** Selected for the fulfillment stock out of task 9a (carry-over D5); not read here. */
        unfulfilledQuantity: z.number().int(),
        variant: z.object({ id: StorableShopifyId }).nullable(),
        originalUnitPriceSet: MoneyBag,
        discountAllocations: z.array(z.object({ allocatedAmountSet: MoneyBag })),
        taxLines: z.array(
          z.object({ rate: z.number().nullable(), ratePercentage: z.number().nullable() }),
        ),
      }),
    ),
    pageInfo: PageInfo,
  }),
  fulfillments: z.array(
    z.object({ id: StorableShopifyId, status: z.string(), createdAt: Instant }),
  ),
  transactions: z.array(
    z.object({
      /** Kept on the mapping at creation (`state.creationTransactionIds`, D10 and D10a). */
      id: StorableShopifyId,
      kind: z.string(),
      status: z.string(),
      gateway: z.string().nullable(),
      amountSet: MoneyBag,
    }),
  ),
});
/** The validated shape of `ShopifyOrder`. */
export type ShopifyOrder = z.infer<typeof ShopifyOrder>;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Why an order could not be read or mapped. A stable code the inbox job records as `failed`. */
export type ShopifyOrderMappingErrorCode =
  | 'ORDER_UNREADABLE'
  | 'NO_OPEN_LINES'
  | 'LINE_ITEMS_TRUNCATED'
  | 'TRANSACTIONS_TRUNCATED'
  | 'FULFILLMENTS_TRUNCATED'
  | 'DISCOUNT_APPLICATIONS_TRUNCATED'
  | 'TAX_LINES_TRUNCATED'
  | 'BAD_AMOUNT'
  | 'BAD_TAX_RATE'
  | 'BAD_REPLACEMENT_NUMBER'
  | 'CONTRACT_REFUSED'
  | 'MAPPING_STATE_UNREADABLE';

const ERROR_TEXT: Readonly<Record<ShopifyOrderMappingErrorCode, string>> = {
  ORDER_UNREADABLE: 'The Shopify order read back does not have the expected shape',
  NO_OPEN_LINES: 'The Shopify order has no line item with a current quantity above 0',
  LINE_ITEMS_TRUNCATED: 'The Shopify order has more line items than one read returns',
  TRANSACTIONS_TRUNCATED: 'The Shopify order has more transactions than one read returns',
  FULFILLMENTS_TRUNCATED: 'The Shopify order has more fulfillments than one read returns',
  DISCOUNT_APPLICATIONS_TRUNCATED:
    'The Shopify order has more discount applications than one read returns',
  TAX_LINES_TRUNCATED: 'A Shopify line item has more tax lines than one read returns',
  BAD_AMOUNT: 'A Shopify amount is not a decimal number',
  BAD_TAX_RATE: 'A Shopify tax rate is not a finite number',
  BAD_REPLACEMENT_NUMBER: 'A replacement number is a whole number from 1',
  CONTRACT_REFUSED: 'The mapped order does not satisfy the channel order contract',
  MAPPING_STATE_UNREADABLE:
    'The stored state of the order mapping does not have the expected shape',
};

/**
 * A typed mapping error (never an error string). The message is fixed text per code plus, for
 * `ORDER_UNREADABLE` and `CONTRACT_REFUSED`, the field paths that failed (`lines.0.title`), never
 * a value: a caller may log `code`, `paths`, and the message safely (Law 151).
 */
export class ShopifyOrderMappingError extends Error {
  /** The field paths that failed, keys and indices only. */
  readonly paths: readonly string[];

  /** Builds the error from its code and the failing field paths (never values). */
  constructor(
    readonly code: ShopifyOrderMappingErrorCode,
    paths: readonly string[] = [],
  ) {
    super(paths.length > 0 ? `${ERROR_TEXT[code]} (${paths.join(', ')})` : ERROR_TEXT[code]);
    this.name = 'ShopifyOrderMappingError';
    this.paths = paths;
  }
}

/** The failing paths of a zod error, keys and indices only (an issue message may echo input). */
function pathsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'))];
}

/** Parses with a schema, turning a refusal into a `ShopifyOrderMappingError` without values. */
function parseOr<T>(schema: ZodType<T>, value: unknown, code: ShopifyOrderMappingErrorCode): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ShopifyOrderMappingError(code, pathsOf(parsed.error));
  return parsed.data;
}

/**
 * Parses the `data.order` of an `ORDER_READ` answer. Throws `ShopifyOrderMappingError`
 * (`ORDER_UNREADABLE`, with the failing paths only) when the shape does not fit; never echoes the
 * read values. A null order (not visible) is the inbox job's `not_visible` case, decided before.
 */
export function parseShopifyOrder(data: unknown): ShopifyOrder {
  const order = parseOr(ShopifyOrder, data, 'ORDER_UNREADABLE');
  // A fulfillment cannot be made after the order's own update time (making it updates the order):
  // one more than a day later is a broken answer, never a carrier delivery time (L3 residual).
  const latest = Date.parse(order.updatedAt) + FULFILLMENT_AFTER_UPDATE_MAX_MS;
  const late = order.fulfillments.findIndex(
    (fulfillment) => Date.parse(fulfillment.createdAt) > latest,
  );
  if (late >= 0) {
    throw new ShopifyOrderMappingError('ORDER_UNREADABLE', [`fulfillments.${late}.createdAt`]);
  }
  return order;
}

/** How far after the order's `updatedAt` a fulfillment's `createdAt` may lie before it is refused. */
const FULFILLMENT_AFTER_UPDATE_MAX_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------------------------
// Context and results
// ---------------------------------------------------------------------------------------------

/**
 * What the inbox job knows and the mapper needs, read by the job from its own rows and settings
 * (the mapper reads no database): the connection's store and channel, the variant mappings, the
 * connection `config`, the `shopify_gift_tags` setting, and the go live instant.
 */
export interface ShopifyOrderContext {
  /** The connection's store. */
  readonly storeId: string;
  /** That store's own channel (`ChannelsService`). */
  readonly channelId: string;
  /** The connection, issuer of the Shopify customer id. */
  readonly connectionId: string;
  /** Shopify variant gid to the app variant id (`connection_external_ids`); absent is unmapped. */
  readonly variants: ReadonlyMap<string, string>;
  /** `config.altPhoneAttribute`: the order custom attribute holding the second phone, or null. */
  readonly altPhoneAttribute: string | null;
  /** `config.gatewayMethods`: a payment gateway name to its payment method. */
  readonly gatewayMethods: Readonly<Record<string, OrderPaymentMethod>>;
  /** The `shopify_gift_tags` setting: a Shopify tag to a gift reason code (AC-10). */
  readonly giftTags: Readonly<Record<string, string>>;
  /** The connection's `go_live_at` (ISO instant); null means every order is live. */
  readonly goLiveAt: string | null;
  /**
   * The rate of a line Shopify sent without tax lines, in percent as `numeric(5,2)` text: the
   * `sales_tax_rate` setting, read by the inbox job (*Value sourcing*, lead decision D8). Absent
   * keeps the old fallback of `0.00`. A line with tax lines always keeps Shopify's rate.
   */
  readonly defaultTaxRate?: string;
}

/** Something about a mapped order the inbox job records on its event or the connection screen. */
export type ShopifyOrderFlag =
  /** `test: true`: the inbox job records `ignored` with `test_order` and calls nothing. */
  | 'test_order'
  /** A listed gift tag on an order whose total is above 0 (AC-10): mapped as a `sale`. */
  | 'gift_tag_not_free'
  /** The gift tag's setting value is a reason code outside `GiftReasonCode`: mapped as `other`. */
  | 'gift_reason_not_a_gift_code';

/** A line whose Shopify variant has no mapping (`state.unmappedLines`); a deleted variant is null. */
export interface ShopifyUnmappedLine {
  readonly channelLineId: string;
  readonly variantGid: string | null;
}

/** What every mapping result carries for the inbox job to record beside the order. */
export interface ShopifyMappingNotes {
  /** Lines mapped with a null `variantId` (AC-9: the job reads their products first). */
  readonly unmappedLines: readonly ShopifyUnmappedLine[];
  /** Payment gateway names with no `config.gatewayMethods` entry, listed until mapped. */
  readonly unmappedGateways: readonly string[];
  /** Every discount code of the order, kept in `state.discountCodes`. */
  readonly discountCodes: readonly string[];
  /** See `ShopifyOrderFlag`. */
  readonly flags: readonly ShopifyOrderFlag[];
}

/** A new order: the contract input and the actor kind its first states need. */
export interface ShopifyOrderMapping extends ShopifyMappingNotes {
  readonly input: ChannelOrderInput;
  /**
   * `import` for a closed order placed before go live (found states), else `system_job` (a live
   * order, or the go live state of an open one), as spec 0013's `planFirstStates` requires.
   */
  readonly actor: 'system_job' | 'import';
}

/** An existing order as Shopify holds it now, for `applyChannelEdit`. */
export interface ShopifySnapshotMapping extends ShopifyMappingNotes {
  readonly snapshot: ChannelOrderSnapshot;
}

/** The replacement order of an exchange by edit (AC-12). */
export interface ShopifyReplacementMapping extends ShopifyMappingNotes {
  readonly input: ChannelOrderInput;
}

// ---------------------------------------------------------------------------------------------
// Value rules
// ---------------------------------------------------------------------------------------------

/**
 * A Shopify `Decimal` (a string such as `"29.99"` or `"29.999"`) in whole cents, exact, rounded
 * half away from zero once. Never a float, never a text comparison.
 */
function centsOf(amount: string): bigint {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new ShopifyOrderMappingError('BAD_AMOUNT');
  const [, sign, whole = '0', fraction = ''] = match;
  let cents = BigInt(whole + fraction.padEnd(2, '0').slice(0, 2));
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1n;
  return sign ? -cents : cents;
}

const textOfCents = (cents: bigint): string => Money.fromCents(cents).toString();

const amountOf = (bag: z.infer<typeof MoneyBag>): bigint => centsOf(bag.shopMoney.amount);

// C0 and C1 controls, and the bidirectional marks and embeddings (ALM, LRM, RLM, LRE to RLO, LRI
// to PDI) a typed field can carry (spec 0002 Follow-up, Value sourcing).
const CONTROL = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;
const CONTROL_KEEPING_BREAKS = /(?![\n\t])[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

/**
 * A typed text with control and direction characters stripped, trimmed, cut to `max` UTF-16
 * units (never splitting a surrogate pair), and null when nothing is left.
 */
function cleanText(
  value: string | null | undefined,
  max: number,
  keepBreaks = false,
): string | null {
  if (value === null || value === undefined) return null;
  // Controls (U+0000 included), then unpaired surrogates: the result is always storable in `text`
  // and `jsonb` (code review R4, security review N4).
  let text = withoutLoneSurrogates(
    value.replace(keepBreaks ? CONTROL_KEEPING_BREAKS : CONTROL, ''),
  ).trim();
  if (text.length > max) {
    text = text.slice(0, max);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trim();
  }
  return text === '' ? null : text;
}

/** The longest Shopify order name the app keeps (`ChannelOrderInput.orderNumber`). */
const ORDER_NAME_MAX = 64;

/** The longest unmapped gateway name listed in a mapping's state. */
const GATEWAY_NAME_MAX = 100;

/**
 * A Shopify order name (`#1001`) as the app keeps it: control and direction characters stripped,
 * trimmed, and cut to `max` characters (security review L6). An empty string when nothing is left,
 * which the contract refuses. The inbox job's `subject_label` uses it too.
 */
export function shopifyOrderName(order: Pick<ShopifyOrder, 'name'>, max = ORDER_NAME_MAX): string {
  return cleanText(order.name, max) ?? '';
}

/** The UTM query keys a stored link may keep (spec 0002 Follow-up m5); every other key is dropped. */
const UTM_ALLOW_LIST: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
];

/**
 * An http or https link with only the allow listed UTM query keys, or null when it is no such
 * link or is longer than the stored 500 characters.
 */
function allowListedLink(link: string | null): string | null {
  const text = cleanText(link, 2048);
  if (text === null) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  for (const key of [...url.searchParams.keys()]) {
    if (!UTM_ALLOW_LIST.includes(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  const kept = url.toString();
  return kept.length > 500 ? null : kept;
}

/** An own entry of a JSON map (never an inherited key such as `constructor`). */
function entryOf<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * The customer's phone (carry-over D4): `defaultPhoneNumber.phoneNumber`, the documented field on
 * `2026-10`, else the deprecated `phone` while Shopify still returns it. The one place that reads
 * a customer phone.
 */
function customerPhoneOf(customer: ShopifyOrder['customer']): string | null {
  if (customer === null) return null;
  return customer.defaultPhoneNumber?.phoneNumber ?? customer.phone;
}

/** The payment of an order as `config.gatewayMethods` reads it (Value sourcing). */
interface ShopifyPayment {
  paymentMethod: OrderPaymentMethod;
  prepaidAmount: string;
  prepaidMethod: OrderPaymentMethod | null;
  unmappedGateways: string[];
}

/**
 * The payment method, prepayment, and unmapped gateway names. Prepaid: successful `SALE` and
 * `CAPTURE` transactions on gateways not mapped to `cod`, net of successful `REFUND`s on them,
 * with the method of the first such sale (`gateway` when its gateway is unmapped); 0 and null when
 * nothing is left. A "mark as paid" `manual` sale on a cod order is on a gateway mapped to `cod`,
 * so the order stays cod with nothing prepaid. The method: the first gateway name that maps; with
 * none, `cod` when no successful sale counted, else `gateway`.
 */
function paymentOf(
  order: ShopifyOrder,
  context: Pick<ShopifyOrderContext, 'gatewayMethods'>,
): ShopifyPayment {
  if (order.transactions.length >= ORDER_READ_TRANSACTIONS_PAGE) {
    throw new ShopifyOrderMappingError('TRANSACTIONS_TRUNCATED');
  }
  // Looked up by the one gateway key (`gatewayKeyOf`), as the creation facts and the rederive do.
  const methodOf = (gateway: string | null): OrderPaymentMethod | undefined => {
    const key = gateway === null ? null : gatewayKeyOf(gateway);
    return key === null ? undefined : entryOf(context.gatewayMethods, key);
  };
  let prepaid = 0n;
  let prepaidMethod: OrderPaymentMethod | null = null;
  let sold = false;
  for (const transaction of order.transactions) {
    if (transaction.status !== 'SUCCESS') continue;
    const method = methodOf(transaction.gateway);
    if (method === 'cod') continue;
    if (transaction.kind === 'SALE' || transaction.kind === 'CAPTURE') {
      prepaid += amountOf(transaction.amountSet);
      prepaidMethod ??= method ?? 'gateway';
      sold = true;
    } else if (transaction.kind === 'REFUND') {
      prepaid -= amountOf(transaction.amountSet);
    }
  }
  // Looked up by the name as Shopify sent it; listed cleaned and capped (security review L6).
  const unmappedGateways = [
    ...new Set(
      order.paymentGatewayNames
        .filter((name) => methodOf(name) === undefined)
        .flatMap((name) => {
          const clean = cleanText(name, GATEWAY_NAME_MAX);
          return clean === null ? [] : [clean];
        }),
    ),
  ];
  const named = order.paymentGatewayNames
    .map(methodOf)
    .find((method): method is OrderPaymentMethod => method !== undefined);
  const paymentMethod = named ?? (sold ? 'gateway' : 'cod');
  return prepaid > 0n && prepaidMethod !== null
    ? { paymentMethod, prepaidAmount: textOfCents(prepaid), prepaidMethod, unmappedGateways }
    : { paymentMethod, prepaidAmount: '0.00', prepaidMethod: null, unmappedGateways };
}

/**
 * The payment of an order as a new order would get it (Value sourcing, `paymentMethod`,
 * `prepaidAmount`, `prepaidMethod`), for `OrderIntake.rederivePaymentMethod` after a gateway
 * mapping change (spec 0013 AC-25 c). Throws `TRANSACTIONS_TRUNCATED` on a full transaction page.
 */
export function shopifyPaymentOf(
  order: ShopifyOrder,
  context: Pick<ShopifyOrderContext, 'gatewayMethods'>,
): RederivePaymentMethodInput {
  const { paymentMethod, prepaidAmount, prepaidMethod } = paymentOf(order, context);
  return { paymentMethod, prepaidAmount, prepaidMethod };
}

/** The longest gateway key `config.gatewayMethods` holds (`connection-config.ts`, 200). */
const GATEWAY_KEY_MAX = 200;

/**
 * A gateway name as `config.gatewayMethods` keys it: the raw Shopify name, capped at the config's
 * 200 characters, never cleaned (security review N1). The one key the creation lookup,
 * `state.creationGateways`, the remap check, and `creationPaymentOf` share, so a name that
 * cleaning would change (padding, a right to left mark, more than 100 characters) never looks
 * remapped. A high surrogate the cut leaves alone is dropped; a name holding U+0000 or an
 * unpaired surrogate answers null (security review N3): PostgreSQL `jsonb` refuses both, so such
 * a name can never be a config key, is treated as unmapped, and is never stored as a key.
 */
export function gatewayKeyOf(name: string): string | null {
  if (!isStorableText(name)) return null;
  const key = name.slice(0, GATEWAY_KEY_MAX);
  const last = key.charCodeAt(key.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? key.slice(0, -1) : key;
}

/** The method `config.gatewayMethods` gives a gateway key, null when unmapped. */
export function gatewayMethodOf(
  context: Pick<ShopifyOrderContext, 'gatewayMethods'>,
  key: string,
): OrderPaymentMethod | null {
  return entryOf(context.gatewayMethods, key) ?? null;
}

/**
 * The order's payment gateway keys (`gatewayKeyOf`) with the method `config.gatewayMethods` gives
 * each now, null when unmapped. The inbox job keeps it once, at creation
 * (`state.creationGateways`, lead decision D10), so a later read back sees when a manager mapped
 * one of those gateways differently (the rederive of spec 0013 AC-25 c); a gateway that appears
 * later is never one. Built with `Object.fromEntries`, so a `__proto__` name stays an own key (L5).
 */
export function gatewayMappingOf(
  order: Pick<ShopifyOrder, 'paymentGatewayNames'>,
  context: Pick<ShopifyOrderContext, 'gatewayMethods'>,
): Record<string, OrderPaymentMethod | null> {
  const entries = new Map<string, OrderPaymentMethod | null>();
  for (const name of order.paymentGatewayNames) {
    const key = gatewayKeyOf(name);
    if (key === null || key === '' || entries.has(key)) continue;
    entries.set(key, gatewayMethodOf(context, key));
  }
  return Object.fromEntries(entries);
}

/** Transaction kinds the prepaid rule reads: payments and the refunds netted against them. */
const CREATION_KINDS: readonly string[] = ['SALE', 'CAPTURE', 'REFUND'];

/**
 * The ids of the order's successful `SALE`, `CAPTURE`, and `REFUND` transactions, whatever their
 * gateway: the transactions known when the order is created, kept immutable on the mapping
 * (`state.creationTransactionIds`, lead decisions D10 and D10a), so a later rederive counts only
 * them. A refund made after creation never counts there: it belongs to the refund path (task 10's
 * `ChannelRefundRecorded`).
 */
export function paymentTransactionIdsOf(order: Pick<ShopifyOrder, 'transactions'>): string[] {
  return order.transactions
    .filter((transaction) => transaction.status === 'SUCCESS')
    .filter((transaction) => CREATION_KINDS.includes(transaction.kind))
    .map((transaction) => transaction.id);
}

/** What an order looked like at creation, as the mapping keeps it (lead decisions D10, D10a). */
export interface ShopifyCreationFacts {
  /** The gateway keys at creation (`gatewayKeyOf`), as `state.creationGateways` keeps them. */
  readonly gatewayNames: readonly string[];
  /** The successful sale, capture, and refund transaction ids at creation. */
  readonly transactionIds: readonly string[];
}

/**
 * The payment of an order derived again from the facts at its creation only (lead decisions D10
 * and D10a, spec 0013 AC-25 c): the creation rules of `paymentOf` with the current
 * `config.gatewayMethods`, over the gateway keys the order had at creation and only the
 * transactions recorded then (its sales, captures, and the refunds that already existed). A
 * gateway, a sale (a "mark as paid" `manual` sale), or a refund added later never counts. Throws
 * `TRANSACTIONS_TRUNCATED` on a full transaction page.
 */
export function creationPaymentOf(
  order: ShopifyOrder,
  context: Pick<ShopifyOrderContext, 'gatewayMethods'>,
  facts: ShopifyCreationFacts,
): RederivePaymentMethodInput {
  if (order.transactions.length >= ORDER_READ_TRANSACTIONS_PAGE) {
    throw new ShopifyOrderMappingError('TRANSACTIONS_TRUNCATED');
  }
  const ids = new Set(facts.transactionIds);
  const transactions = order.transactions.filter((transaction) => ids.has(transaction.id));
  return shopifyPaymentOf(
    { ...order, paymentGatewayNames: [...facts.gatewayNames], transactions },
    context,
  );
}

/**
 * The type and gift reason (AC-10): a listed tag (matched without regard to case) on an order
 * whose total (lines and shipping, `totalPriceSet`) is 0 gives `gifted` with that tag's reason; on
 * a paid order a `sale` flagged `gift_tag_not_free`. A reason outside `GiftReasonCode` maps to
 * `other`, flagged `gift_reason_not_a_gift_code`.
 */
function giftOf(
  order: ShopifyOrder,
  context: Pick<ShopifyOrderContext, 'giftTags'>,
): { type: 'sale' | 'gifted'; giftReasonCode: GiftReasonCode | null; flags: ShopifyOrderFlag[] } {
  const listed = new Map(
    Object.entries(context.giftTags).map(([tag, reason]) => [tag.trim().toLowerCase(), reason]),
  );
  const reason = order.tags
    .map((tag) => listed.get(tag.trim().toLowerCase()))
    .find((value): value is string => value !== undefined);
  if (reason === undefined) return { type: 'sale', giftReasonCode: null, flags: [] };
  if (amountOf(order.totalPriceSet) !== 0n) {
    return { type: 'sale', giftReasonCode: null, flags: ['gift_tag_not_free'] };
  }
  const gift = GiftReasonCode.safeParse(reason);
  return gift.success
    ? { type: 'gifted', giftReasonCode: gift.data, flags: [] }
    : { type: 'gifted', giftReasonCode: 'other', flags: ['gift_reason_not_a_gift_code'] };
}

/**
 * The discount code (Value sourcing): the first of `discountCodes` that is not a shipping
 * discount, a shipping discount being a `DiscountCodeApplication` whose `targetType` is
 * `SHIPPING_LINE` (carry-over D6); every code is kept for `state.discountCodes`, each with the
 * control and direction clean up and capped at 255 characters (security review L6). Throws
 * `DISCOUNT_APPLICATIONS_TRUNCATED` when the read did not hold every application (a shipping code
 * on a later page could otherwise be taken as the discount code).
 */
function discountOf(order: ShopifyOrder): { discountCode: string | null; discountCodes: string[] } {
  if (order.discountApplications.pageInfo.hasNextPage) {
    throw new ShopifyOrderMappingError('DISCOUNT_APPLICATIONS_TRUNCATED');
  }
  const shipping = new Set(
    order.discountApplications.nodes
      .filter((node) => node.__typename === 'DiscountCodeApplication')
      .filter((node) => node.targetType === 'SHIPPING_LINE')
      .map((node) => node.code)
      .filter((code): code is string => code !== undefined),
  );
  const first = [...new Set(order.discountCodes)].find((code) => !shipping.has(code));
  const discountCodes = [
    ...new Set(
      order.discountCodes.flatMap((code) => {
        const clean = cleanText(code, 255);
        return clean === null ? [] : [clean];
      }),
    ),
  ];
  return { discountCode: cleanText(first, 255), discountCodes };
}

/**
 * A line's tax rate in percent with 2 decimals: the sum of its tax lines' percentages; with no tax
 * line, the context's `defaultTaxRate` (the `sales_tax_rate` setting), else 0. A full page of tax
 * lines (`ORDER_READ_TAX_LINES_PAGE`, 10) may hide more, so it throws `TAX_LINES_TRUNCATED` rather
 * than under sum the rate.
 */
function taxRateOf(
  taxLines: ShopifyOrder['lineItems']['nodes'][number]['taxLines'],
  defaultTaxRate: string | undefined,
): string {
  if (taxLines.length >= ORDER_READ_TAX_LINES_PAGE) {
    throw new ShopifyOrderMappingError('TAX_LINES_TRUNCATED');
  }
  if (taxLines.length === 0 && defaultTaxRate !== undefined) return defaultTaxRate;
  let hundredths = 0;
  for (const line of taxLines) {
    const percent = line.ratePercentage ?? (line.rate === null ? 0 : line.rate * 100);
    if (!Number.isFinite(percent)) throw new ShopifyOrderMappingError('BAD_TAX_RATE');
    hundredths += Math.round(percent * 100);
  }
  return textOfCents(BigInt(hundredths));
}

/**
 * The lines with a current quantity above 0 (or, given `held`, exactly the held line items at the
 * held quantities) and the ones whose variant has no mapping.
 */
function linesOf(
  order: ShopifyOrder,
  context: Pick<ShopifyOrderContext, 'variants' | 'defaultTaxRate'>,
  held?: ReadonlyMap<string, number>,
) {
  if (order.lineItems.pageInfo.hasNextPage) {
    throw new ShopifyOrderMappingError('LINE_ITEMS_TRUNCATED');
  }
  const unmappedLines: ShopifyUnmappedLine[] = [];
  const quantityOf = (line: ShopifyOrder['lineItems']['nodes'][number]): number =>
    held ? (held.get(line.id) ?? 0) : line.currentQuantity;
  const lines = order.lineItems.nodes
    .filter((line) => quantityOf(line) > 0)
    .map((line) => {
      const variantId = line.variant ? (context.variants.get(line.variant.id) ?? null) : null;
      if (variantId === null) {
        unmappedLines.push({ channelLineId: line.id, variantGid: line.variant?.id ?? null });
      }
      const discount = line.discountAllocations.reduce(
        (sum, allocation) => sum + amountOf(allocation.allocatedAmountSet),
        0n,
      );
      return {
        channelLineId: line.id,
        variantId,
        title: cleanText([line.title, line.variantTitle].filter(Boolean).join(' '), 500),
        quantity: quantityOf(line),
        unitPrice: textOfCents(amountOf(line.originalUnitPriceSet)),
        discountAmount: textOfCents(discount),
        taxRate: taxRateOf(line.taxLines, context.defaultTaxRate),
      };
    });
  return { lines, unmappedLines };
}

/** Where the parcel goes (Value sourcing): ship to phone, else order phone, else customer phone. */
function shipToOf(order: ShopifyOrder, context: Pick<ShopifyOrderContext, 'altPhoneAttribute'>) {
  const address = order.shippingAddress;
  const alt =
    context.altPhoneAttribute === null
      ? null
      : (order.customAttributes.find((attribute) => attribute.key === context.altPhoneAttribute)
          ?.value ?? null);
  const phone =
    cleanText(address?.phone, 64) ??
    cleanText(order.phone, 64) ??
    cleanText(customerPhoneOf(order.customer), 64);
  const joined = address
    ? [address.address1, address.address2, address.city, address.province]
        .map((part) => cleanText(part, 500))
        .filter((part): part is string => part !== null)
        .join(', ')
    : '';
  return {
    name: cleanText(address?.name, 200),
    phone,
    phoneAlt: cleanText(alt, 64),
    address: cleanText(joined, 500),
  };
}

/** The campaign fields (Value sourcing): the last visit, else the first; `none` without one. */
function sourceOf(order: ShopifyOrder) {
  const visit =
    order.customerJourneySummary?.lastVisit ?? order.customerJourneySummary?.firstVisit ?? null;
  if (visit === null) return { capturedFrom: 'none' as const };
  return {
    capturedFrom: 'shopify_journey' as const,
    utmSource: cleanText(visit.utmParameters?.source, 500),
    utmMedium: cleanText(visit.utmParameters?.medium, 500),
    utmCampaign: cleanText(visit.utmParameters?.campaign, 500),
    utmContent: cleanText(visit.utmParameters?.content, 500),
    landingPage: allowListedLink(visit.landingPage),
    referrer: allowListedLink(visit.referrerUrl),
  };
}

/** The fields an order and its later snapshots share, and the notes for the inbox job. */
function sharedOf(
  order: ShopifyOrder,
  context: ShopifyOrderContext,
  held?: ReadonlyMap<string, number>,
) {
  const payment = paymentOf(order, context);
  const gift = giftOf(order, context);
  const discount = discountOf(order);
  const { lines, unmappedLines } = linesOf(order, context, held);
  if (lines.length === 0) throw new ShopifyOrderMappingError('NO_OPEN_LINES');
  const flags: ShopifyOrderFlag[] = [...(order.test ? ['test_order' as const] : []), ...gift.flags];
  return {
    payment,
    fields: {
      type: gift.type,
      giftReasonCode: gift.giftReasonCode,
      paymentMethod: payment.paymentMethod,
      shippingChargedAmount: textOfCents(amountOf(order.totalShippingPriceSet)),
      discountCode: discount.discountCode,
      customerNote: cleanText(order.note, 2000, true),
      channelCustomer: order.customer
        ? {
            kind: 'shopify_customer' as const,
            connectionId: context.connectionId,
            externalId: order.customer.id,
          }
        : null,
      source: sourceOf(order),
      shipTo: shipToOf(order, context),
      lines,
    },
    notes: {
      unmappedLines,
      unmappedGateways: payment.unmappedGateways,
      discountCodes: discount.discountCodes,
      flags,
    } satisfies ShopifyMappingNotes,
  };
}

// ---------------------------------------------------------------------------------------------
// Exported mappings
// ---------------------------------------------------------------------------------------------

/** Fulfillment statuses that are not active (`FulfillmentStatus` on `2026-10`). */
const INACTIVE_FULFILLMENT: readonly string[] = ['CANCELLED', 'ERROR', 'FAILURE'];

/**
 * The first active fulfillment (AC-13): the earliest by `createdAt` whose status is not
 * `CANCELLED`, `ERROR`, or `FAILURE`; null when none. Its id and time are the carrier delivery
 * source (`shopify_fulfillment`) and time. Throws `FULFILLMENTS_TRUNCATED` on a full read page.
 */
export function firstActiveFulfillmentOf(
  order: ShopifyOrder,
): { id: string; createdAt: string } | null {
  if (order.fulfillments.length >= ORDER_READ_FULFILLMENTS_PAGE) {
    throw new ShopifyOrderMappingError('FULFILLMENTS_TRUNCATED');
  }
  const active = order.fulfillments
    .filter((fulfillment) => !INACTIVE_FULFILLMENT.includes(fulfillment.status))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const first = active[0];
  return first ? { id: first.id, createdAt: first.createdAt } : null;
}

/**
 * The cancel reason code (AC-13): `channel.` plus Shopify's `cancelReason` in lower case, or
 * `channel.other` when that does not fit the `ReasonCode` shape or Shopify gave none; null for an
 * order that is not cancelled.
 */
export function cancelReasonCodeOf(order: ShopifyOrder): string | null {
  if (order.cancelledAt === null && order.cancelReason === null) return null;
  const code = `channel.${(order.cancelReason ?? '').toLowerCase()}`;
  return order.cancelReason !== null && ReasonCode.safeParse(code).success ? code : 'channel.other';
}

/**
 * The states an `import` finds a closed order in (Value sourcing, AC-17): cancelled is `cancelled`
 * with `nothing_to_collect` and its reason code; fulfilled (an active fulfillment) is `shipped`
 * with the first active fulfillment's time and the first cash rule of spec 0002 on Shopify's
 * current total: `unpaid` while the total is above the prepayment, else `prepaid`, else
 * `nothing_to_collect`. Null for an open order.
 */
export function foundStatesOf(
  order: ShopifyOrder,
  context: Pick<ShopifyOrderContext, 'gatewayMethods'>,
): ImportFirstStates | null {
  const reason = cancelReasonCodeOf(order);
  if (order.cancelledAt !== null && reason !== null) {
    return ImportFirstStates.parse({
      fulfillment: 'cancelled',
      cash: 'nothing_to_collect',
      cancelReasonCode: reason,
    });
  }
  const first = firstActiveFulfillmentOf(order);
  if (first === null) return null;
  const prepaid = centsOf(paymentOf(order, context).prepaidAmount);
  const total = amountOf(order.currentTotalPriceSet);
  const cash = total > prepaid ? 'unpaid' : prepaid > 0n ? 'prepaid' : 'nothing_to_collect';
  return ImportFirstStates.parse({
    fulfillment: 'shipped',
    cash,
    carrierDeliveryCreatedAt: first.createdAt,
  });
}

const GO_LIVE_STATES: GoLiveFirstStates = {
  fulfillment: 'confirmed',
  reasonCode: 'go_live_import',
};

/**
 * A Shopify order as a new app order (AC-9, AC-10, AC-17): store, channel, and customer from the
 * context, `channelOrderRef` the order gid, `orderNumber` its name, `placedAt` its creation time,
 * every other field by *Value sourcing*. Placed before `goLiveAt`, an open order gets the go live
 * state (actor `system_job`) and a closed one its found states (actor `import`). A test order is
 * mapped and flagged `test_order`, for the job to ignore. Throws `ShopifyOrderMappingError`.
 */
export function mapShopifyOrder(
  order: ShopifyOrder,
  context: ShopifyOrderContext,
): ShopifyOrderMapping {
  const { payment, fields, notes } = sharedOf(order, context);
  const beforeGoLive =
    context.goLiveAt !== null && Date.parse(order.createdAt) < Date.parse(context.goLiveAt);
  const found = beforeGoLive ? foundStatesOf(order, context) : null;
  const input = parseOr(
    ChannelOrderInput,
    {
      storeId: context.storeId,
      channelId: context.channelId,
      channelOrderRef: order.id,
      orderNumber: shopifyOrderName(order),
      placedAt: order.createdAt,
      prepaidAmount: payment.prepaidAmount,
      prepaidMethod: payment.prepaidMethod,
      firstStates: found ?? (beforeGoLive ? GO_LIVE_STATES : null),
      ...fields,
    },
    'CONTRACT_REFUSED',
  );
  return { input, actor: found ? 'import' : 'system_job', ...notes };
}

/**
 * A Shopify order as the snapshot of an existing app order (AC-11, `applyChannelEdit`): the shared
 * fields of `mapShopifyOrder`, without identity, prepayment, related order, and first states.
 * Without `held`, the lines are every line item with a current quantity above 0 (no fulfillment
 * active). With `held` (a fulfillment is active, Inbound processing item 4), the lines are exactly
 * the held line items at the held quantities (what the app order holds), so added lines (task 10's
 * exchange by edit) and refunded quantities (task 10's `ChannelRefundRecorded`) never reach
 * `applyChannelEdit`, and only ship to and other changes do. Throws `ShopifyOrderMappingError`.
 */
export function mapShopifyOrderSnapshot(
  order: ShopifyOrder,
  context: ShopifyOrderContext,
  held?: ReadonlyMap<string, number>,
): ShopifySnapshotMapping {
  const { fields, notes } = sharedOf(order, context, held);
  return { snapshot: parseOr(ChannelOrderSnapshot, fields, 'CONTRACT_REFUSED'), ...notes };
}

/** What a replacement order needs beyond the Shopify order (AC-12). */
export interface ShopifyReplacementRequest {
  /** The app order the replacement is for (`replacement_for`). */
  readonly originalOrderId: string;
  /** The replacement's number on this order, from 1: `#1001-R<n>`, ref `<gid>:R<n>`. */
  readonly n: number;
  /** The Shopify line item ids the app already holds (the original and earlier replacements). */
  readonly knownLineIds: ReadonlySet<string>;
}

/**
 * The replacement order of an exchange made by editing a delivered order (AC-12): only the line
 * items with a current quantity above 0 that `knownLineIds` does not hold, numbered
 * `<name>-R<n>`, ref `<gid>:R<n>`, no shipping charge, no discount code, no note, nothing prepaid,
 * linked `replacement_for` the original. Null when no line was added. Throws
 * `ShopifyOrderMappingError`.
 */
export function replacementInput(
  order: ShopifyOrder,
  request: ShopifyReplacementRequest,
  context: ShopifyOrderContext,
): ShopifyReplacementMapping | null {
  if (!Number.isInteger(request.n) || request.n < 1) {
    throw new ShopifyOrderMappingError('BAD_REPLACEMENT_NUMBER');
  }
  const { fields, notes } = sharedOf(order, context);
  const lines = fields.lines.filter((line) => !request.knownLineIds.has(line.channelLineId));
  if (lines.length === 0) return null;
  const input = parseOr(
    ChannelOrderInput,
    {
      storeId: context.storeId,
      channelId: context.channelId,
      channelOrderRef: `${order.id}:R${request.n}`,
      orderNumber: `${shopifyOrderName(order, ORDER_NAME_MAX - `-R${request.n}`.length)}-R${request.n}`,
      placedAt: order.createdAt,
      relatedOrder: { orderId: request.originalOrderId, relation: 'replacement_for' },
      ...fields,
      shippingChargedAmount: '0.00',
      discountCode: null,
      customerNote: null,
      lines,
    },
    'CONTRACT_REFUSED',
  );
  return {
    input,
    ...notes,
    unmappedLines: notes.unmappedLines.filter((line) =>
      lines.some((kept) => kept.channelLineId === line.channelLineId),
    ),
  };
}
