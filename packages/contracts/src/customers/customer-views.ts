import { z } from 'zod';
import type { Permission } from '../access.js';
import { LocalizedText } from '../localized-text.js';
import {
  CustomerExternalIdKind,
  CustomerRiskFlag,
  CustomerRiskFlagSource,
} from './customer-enums.js';
import { PhoneKind } from './egyptian-phone.js';

const Timestamp = z.iso.datetime({ offset: true });

/**
 * A customer as a list row shows her (spec 0014 API table): the canonical id, name, primary phone
 * (E.164), how many phones she holds over all her ids, her flag, and when the record was created.
 * Name and phone are personal data: staff with `customers.view` only.
 */
export const CustomerBrief = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  primaryPhone: z.string().nullable(),
  phoneCount: z.number().int().min(0),
  flagKind: CustomerRiskFlag.nullable(),
  flagSource: CustomerRiskFlagSource.nullable(),
  createdAt: Timestamp,
});
/** The validated shape of `CustomerBrief`. */
export type CustomerBrief = z.infer<typeof CustomerBrief>;

/** One phone of a customer, with its kind and when it was first and last seen. */
export const CustomerPhoneView = z.object({
  e164: z.string(),
  kind: PhoneKind,
  isPrimary: z.boolean(),
  firstSeenAt: Timestamp,
  lastSeenAt: Timestamp,
});
/** The validated shape of `CustomerPhoneView`. */
export type CustomerPhoneView = z.infer<typeof CustomerPhoneView>;

/**
 * One id an outside system gave the customer, with where it came from: the store of a Shopify
 * connection, or the channel of a partner reference. A label is null when it cannot be resolved
 * (the connectors module has not registered its connection store source yet).
 */
export const CustomerChannelIdView = z.object({
  id: z.uuid(),
  kind: CustomerExternalIdKind,
  externalId: z.string(),
  storeCode: z.string().nullable(),
  storeName: LocalizedText.nullable(),
  channelCode: z.string().nullable(),
  channelName: LocalizedText.nullable(),
  createdAt: Timestamp,
});
/** The validated shape of `CustomerChannelIdView`. */
export type CustomerChannelIdView = z.infer<typeof CustomerChannelIdView>;

/** A merge the customer absorbed: which record, when, and whether it can still be undone. */
export const CustomerAbsorbedMerge = z.object({
  mergeId: z.uuid(),
  other: CustomerBrief,
  at: Timestamp,
  undoable: z.boolean(),
});
/** The validated shape of `CustomerAbsorbedMerge`. */
export type CustomerAbsorbedMerge = z.infer<typeof CustomerAbsorbedMerge>;

/** A customer's flag: kind, source, who set it (a person's name, or null for an import), when, and the note. */
export const CustomerFlagView = z.object({
  kind: CustomerRiskFlag,
  source: CustomerRiskFlagSource,
  note: z.string().nullable(),
  setAt: Timestamp,
  setByName: z.string().nullable(),
});
/** The validated shape of `CustomerFlagView`. */
export type CustomerFlagView = z.infer<typeof CustomerFlagView>;

/**
 * The returner signal of the profile (spec 0014 AC-13): how many of the customer's orders were
 * refused at the door and how many came back after delivery within the last `windowDays`
 * operating days (gifted orders left out), and the flag kind the header suggests, or null. A kind
 * is suggested only when the customer has no flag: `refuser` when refusals reach the setting's
 * `refusalsToSuggest`, else `returner` when returns reach `returnsToSuggest` (setting
 * `customer_risk_signal`). Computed on each read, never stored.
 */
export const CustomerRiskSignal = z.object({
  refusals: z.number().int().min(0),
  returns: z.number().int().min(0),
  windowDays: z.number().int().min(1),
  suggestedKind: z.enum(['refuser', 'returner']).nullable(),
});
/** The validated shape of `CustomerRiskSignal`. */
export type CustomerRiskSignal = z.infer<typeof CustomerRiskSignal>;

/**
 * The one rule of the suggested flag kind (AC-13), shared by the profile read and the server side
 * check of a `suggestion_applied` flag set: nothing when the customer is flagged; refusals are
 * checked first, so a customer at both thresholds is suggested `refuser`.
 */
export function suggestedRiskFlag(
  counts: { refusals: number; returns: number },
  thresholds: { refusalsToSuggest: number; returnsToSuggest: number },
  flagged: boolean,
): CustomerRiskSignal['suggestedKind'] {
  if (flagged) return null;
  if (counts.refusals >= thresholds.refusalsToSuggest) return 'refuser';
  if (counts.returns >= thresholds.returnsToSuggest) return 'returner';
  return null;
}

/**
 * The profile fields that read order data, each with the permission it needs (spec 0014 AC-15:
 * order data needs `orders.view`). The api leaves a field out of the answer for a viewer without
 * it, so the keys are optional in `CustomerProfile`.
 */
export const CUSTOMER_PROFILE_GUARDED_FIELDS = {
  signal: 'orders.view',
  orderCount: 'orders.view',
} as const satisfies Readonly<Record<string, Permission>>;

/**
 * `GET /api/customers/:id` (spec 0014 AC-4): the canonical customer with the union of phones and
 * channel ids over all her ids. `resolvedFrom` is the id that was asked when it was a merged
 * record, else null. `updatedAt` is the customer's stamp, the greatest `updated_at` over all her
 * ids, so absorbing a record moves it (the flag routes check it). From milestone 4 it carries the
 * returner `signal` and the `orderCount`, both only for a viewer with `orders.view`
 * (`CUSTOMER_PROFILE_GUARDED_FIELDS`).
 */
export const CustomerProfile = z.object({
  id: z.uuid(),
  resolvedFrom: z.uuid().nullable(),
  name: z.string().nullable(),
  phones: z.array(CustomerPhoneView),
  channelIds: z.array(CustomerChannelIdView),
  merges: z.array(CustomerAbsorbedMerge),
  flag: CustomerFlagView.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** The returner signal (AC-13); present only for a viewer with `orders.view`. */
  signal: CustomerRiskSignal.optional(),
  /** Every order of every id of the customer, all time, any type (the merge compare, AC-7); `orders.view` only. */
  orderCount: z.number().int().min(0).optional(),
});
/** The validated shape of `CustomerProfile`. */
export type CustomerProfile = z.infer<typeof CustomerProfile>;
