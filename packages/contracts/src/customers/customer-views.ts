import { z } from 'zod';
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
 * `GET /api/customers/:id` (spec 0014 AC-4): the canonical customer with the union of phones and
 * channel ids over all her ids. `resolvedFrom` is the id that was asked when it was a merged
 * record, else null. `updatedAt` is the customer's stamp, the greatest `updated_at` over all her
 * ids, so absorbing a record moves it (the flag routes check it).
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
});
/** The validated shape of `CustomerProfile`. */
export type CustomerProfile = z.infer<typeof CustomerProfile>;
