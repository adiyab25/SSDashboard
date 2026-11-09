// The Shopify customer mapper (spec 0015 AC-15, Value sourcing "customer webhook"). Pure: no
// database, no clock, no log, no Shopify call. The inbox job reads the customer back with
// `CUSTOMER_READ`, parses it here, and hands the result to `CustomersService.findOrCreate`
// (spec 0014 AC-1). Law 151: nothing here logs, and no thrown message carries a read value.
import { EgyptianPhone, InvalidPhone, type NormalizedPhone } from '@ssdashboard/contracts';
import { z } from 'zod';

/**
 * The part of a Shopify `Customer` the mapper reads, field for field what `CUSTOMER_READ`
 * selects (`shopify-queries.ts`, `2026-10`). Unknown keys are stripped.
 */
export const ShopifyCustomer = z.object({
  id: z.string().min(1),
  updatedAt: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  defaultPhoneNumber: z.object({ phoneNumber: z.string() }).nullable(),
  /** Deprecated on `2026-10` (carry-over D4): read only when `defaultPhoneNumber` is null. */
  phone: z.string().nullable(),
});
/** The validated shape of `ShopifyCustomer`. */
export type ShopifyCustomer = z.infer<typeof ShopifyCustomer>;

/** Why a customer read back could not be used: a stable code the inbox job records as `failed`. */
export type ShopifyCustomerMappingErrorCode = 'CUSTOMER_UNREADABLE';

/**
 * A typed customer mapping error. The message is fixed text plus the failing field paths (keys
 * only), never a value, so a caller may log it safely (Law 151).
 */
export class ShopifyCustomerMappingError extends Error {
  /** The field paths that failed, keys and indices only. */
  readonly paths: readonly string[];

  /** Builds the error from its code and the failing field paths (never values). */
  constructor(
    readonly code: ShopifyCustomerMappingErrorCode,
    paths: readonly string[] = [],
  ) {
    const text = 'The Shopify customer read back does not have the expected shape';
    super(paths.length > 0 ? `${text} (${paths.join(', ')})` : text);
    this.name = 'ShopifyCustomerMappingError';
    this.paths = paths;
  }
}

/**
 * Parses the `data.customer` of a `CUSTOMER_READ` answer. Throws `ShopifyCustomerMappingError`
 * (`CUSTOMER_UNREADABLE`, paths only) when the shape does not fit. A null customer (not visible)
 * is the inbox job's `not_visible` case, decided before.
 */
export function parseShopifyCustomer(data: unknown): ShopifyCustomer {
  const parsed = ShopifyCustomer.safeParse(data);
  if (!parsed.success) {
    throw new ShopifyCustomerMappingError('CUSTOMER_UNREADABLE', [
      ...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)')),
    ]);
  }
  return parsed.data;
}

// C0 and C1 controls and the bidirectional marks, as the order mapper strips them.
const CONTROL = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** The longest customer name passed on (as the order mapper's ship to name). */
const NAME_MAX = 200;

/** A typed text without control and direction characters, trimmed, capped, or null when empty. */
function cleanText(value: string | null, max: number): string | null {
  if (value === null) return null;
  let text = value.replace(CONTROL, '').trim();
  if (text.length > max) {
    text = text.slice(0, max);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trim();
  }
  return text === '' ? null : text;
}

/** What `CustomersService.findOrCreate` takes from a Shopify customer (spec 0015 AC-15). */
export interface ShopifyCustomerInput {
  /** `EgyptianPhone.parse` of the customer's phone, or null when absent or it does not parse. */
  readonly phone: NormalizedPhone | null;
  /** The Shopify customer id, issued by this connection. */
  readonly channelCustomer: {
    readonly kind: 'shopify_customer';
    readonly connectionId: string;
    readonly externalId: string;
  };
  /** The first and last name joined, or null. */
  readonly name: string | null;
  /** The customer's `updatedAt`, as `seenAt`. */
  readonly seenAt: Date;
}

/**
 * A Shopify customer as `findOrCreate`'s input (Value sourcing "customer webhook"): the phone is
 * `defaultPhoneNumber.phoneNumber`, else the deprecated `phone` (carry-over D4), parsed with
 * `EgyptianPhone.parse` at this edge and null when it does not parse; the channel id is
 * `shopify_customer` with the connection and the customer gid; the name is the first and last name
 * joined; `seenAt` is `updatedAt`. A null phone is the inbox job's `no_phone` (nothing written).
 */
export function mapShopifyCustomer(
  customer: ShopifyCustomer,
  connectionId: string,
): ShopifyCustomerInput {
  const raw = customer.defaultPhoneNumber?.phoneNumber ?? customer.phone;
  let phone: NormalizedPhone | null = null;
  if (raw !== null && raw.trim() !== '') {
    try {
      phone = EgyptianPhone.parse(raw);
    } catch (error) {
      if (!(error instanceof InvalidPhone)) throw error;
    }
  }
  const name = cleanText(
    [customer.firstName, customer.lastName]
      .map((part) => cleanText(part, NAME_MAX))
      .filter((part): part is string => part !== null)
      .join(' '),
    NAME_MAX,
  );
  const at = Date.parse(customer.updatedAt);
  if (Number.isNaN(at)) throw new ShopifyCustomerMappingError('CUSTOMER_UNREADABLE', ['updatedAt']);
  return {
    phone,
    channelCustomer: { kind: 'shopify_customer', connectionId, externalId: customer.id },
    name,
    seenAt: new Date(at),
  };
}
