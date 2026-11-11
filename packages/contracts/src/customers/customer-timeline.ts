import { z } from 'zod';
import type { Permission } from '../access.js';
import { LocalizedText } from '../localized-text.js';
import { MoneyString } from '../money.js';
import { OrderOutcome } from '../orders/order-outcome.js';
import { CashState, FulfillmentState } from '../orders/order-states.js';
import { OrderPaymentMethod } from '../orders/payment-method.js';
import {
  CustomerExternalIdKind,
  CustomerRiskFlag,
  CustomerRiskFlagSource,
} from './customer-enums.js';
import { CustomerBrief } from './customer-views.js';
import { PhoneKind } from './egyptian-phone.js';

const Timestamp = z.iso.datetime({ offset: true });

/** Every entry kind of the customer timeline in this feature (spec 0014 AC-14). */
export const CustomerTimelineKind = z.enum([
  'order',
  'merge',
  'unmerge',
  'phone_added',
  'channel_id_added',
  'flag',
]);
/** One timeline entry kind. */
export type CustomerTimelineKind = z.infer<typeof CustomerTimelineKind>;

/** What one timeline entry kind needs: the permission to see it at all, and one per guarded field or action. */
export interface CustomerTimelineKindRule {
  /** The permission a viewer needs to get entries of this kind. */
  readonly needs: Permission;
  /** Each guarded field or action of the entry, with the permission it needs on top of `needs`. */
  readonly guarded: Readonly<Record<string, Permission>>;
}

/**
 * The lens table of spec 0014 AC-15: the permission each timeline entry kind needs, and each
 * guarded field or action on it. The api leaves out every kind and field the viewer's permissions
 * do not reach (`timelineLens`), so each hat sees the same records through its own lens. A later
 * feature adds its kind here, with its permission, in its own build; never add a kind without one.
 */
export const CUSTOMER_TIMELINE_KINDS = {
  order: { needs: 'orders.view', guarded: {} },
  merge: { needs: 'customers.view', guarded: { undoable: 'customers.merge', audit: 'audit.read' } },
  unmerge: { needs: 'customers.view', guarded: { audit: 'audit.read' } },
  phone_added: { needs: 'customers.view', guarded: {} },
  channel_id_added: { needs: 'customers.view', guarded: {} },
  flag: { needs: 'customers.view', guarded: {} },
} as const satisfies Readonly<Record<CustomerTimelineKind, CustomerTimelineKindRule>>;

/** What a viewer may see of the timeline: the kinds, and per kind the guarded fields it reaches. */
export interface CustomerTimelineLens {
  /** The kinds the viewer reaches, in `CustomerTimelineKind` order. */
  kinds: CustomerTimelineKind[];
  /** Whether the viewer reaches a guarded field or action of a kind (false for a kind it does not reach). */
  shows(kind: CustomerTimelineKind, field: string): boolean;
}

/**
 * The lens of one viewer over `CUSTOMER_TIMELINE_KINDS`, from a permission check (the api passes
 * `access.has`). Pure: it never reads a session, and it must stay the only place the timeline
 * decides what a hat sees.
 */
export function timelineLens(has: (permission: Permission) => boolean): CustomerTimelineLens {
  const kinds = CustomerTimelineKind.options.filter((kind) =>
    has(CUSTOMER_TIMELINE_KINDS[kind].needs),
  );
  const reached = new Set(kinds);
  return {
    kinds,
    shows(kind, field) {
      if (!reached.has(kind)) return false;
      const guarded: Readonly<Record<string, Permission>> = CUSTOMER_TIMELINE_KINDS[kind].guarded;
      const needs = Object.hasOwn(guarded, field) ? guarded[field] : undefined;
      return needs !== undefined && has(needs);
    },
  };
}

/**
 * `GET /api/customers/:id/timeline` query (spec 0014 API table): `cursor` from the last page,
 * `limit` 1 to 50 (default 25), and `kinds`, a comma separated list of entry kinds (absent: every
 * kind the viewer reaches; a kind the viewer does not reach is left out, never an error).
 */
export const CustomerTimelineQuery = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  kinds: z
    .string()
    .max(200)
    .transform((value) => value.split(','))
    .pipe(z.array(CustomerTimelineKind).min(1))
    .optional(),
});
/** The validated shape of `CustomerTimelineQuery`, after defaults. */
export type CustomerTimelineQuery = z.infer<typeof CustomerTimelineQuery>;

/**
 * Where the audit screen shows a record's history (`/audit?recordType=&recordId=`). Present only
 * for a viewer with `audit.read`.
 */
export const CustomerTimelineAuditLink = z.object({
  recordType: z.literal('customer'),
  recordId: z.uuid(),
});
/** The validated shape of `CustomerTimelineAuditLink`. */
export type CustomerTimelineAuditLink = z.infer<typeof CustomerTimelineAuditLink>;

/** One order of the customer (`orders.view`): number with its store, states, outcome, total, payment method. */
export const CustomerTimelineOrderEntry = z.object({
  kind: z.literal('order'),
  /** The order id (links to `/orders/:id`). */
  id: z.uuid(),
  /** The order's placed time. */
  at: Timestamp,
  storeCode: z.string(),
  orderNumber: z.string(),
  fulfillmentState: FulfillmentState,
  cashState: CashState,
  outcome: OrderOutcome,
  totalAmount: MoneyString,
  paymentMethod: OrderPaymentMethod,
  refusedReasonCode: z.string().nullable(),
});
/** The validated shape of `CustomerTimelineOrderEntry`. */
export type CustomerTimelineOrderEntry = z.infer<typeof CustomerTimelineOrderEntry>;

const mergeFields = {
  /** The `customer_merges` row id (for a merge, the id the undo route takes). */
  id: z.uuid(),
  /** When the merge or undo was recorded. */
  at: Timestamp,
  /** The other customer record of the merge, as a brief (personal data, `customers.view`). */
  other: CustomerBrief,
  /** Whether `other` is the record merged away (`merged`) or the survivor it went into (`survivor`). */
  otherRole: z.enum(['merged', 'survivor']),
  /** The name of the person who merged or undid, or null when it cannot be read. */
  actorName: z.string().nullable(),
  reasonCode: z.string().nullable(),
  /** Present only with `audit.read`: the merged record's history on the audit screen. */
  audit: CustomerTimelineAuditLink.optional(),
};

/**
 * A merge (`customers.view`). `undoable` is present only for a viewer with `customers.merge`, and
 * then says whether the merge can still be undone (live, and the latest on its customers).
 */
export const CustomerTimelineMergeEntry = z.object({
  kind: z.literal('merge'),
  ...mergeFields,
  undoable: z.boolean().optional(),
});
/** The validated shape of `CustomerTimelineMergeEntry`. */
export type CustomerTimelineMergeEntry = z.infer<typeof CustomerTimelineMergeEntry>;

/** The undo of a merge (`customers.view`). */
export const CustomerTimelineUnmergeEntry = z.object({
  kind: z.literal('unmerge'),
  ...mergeFields,
});
/** The validated shape of `CustomerTimelineUnmergeEntry`. */
export type CustomerTimelineUnmergeEntry = z.infer<typeof CustomerTimelineUnmergeEntry>;

/** A phone the customer holds, at its first seen time (`customers.view`; shown inside `LtrText`). */
export const CustomerTimelinePhoneEntry = z.object({
  kind: z.literal('phone_added'),
  id: z.uuid(),
  at: Timestamp,
  e164: z.string(),
  phoneKind: PhoneKind,
  isPrimary: z.boolean(),
});
/** The validated shape of `CustomerTimelinePhoneEntry`. */
export type CustomerTimelinePhoneEntry = z.infer<typeof CustomerTimelinePhoneEntry>;

/** A channel customer id attached to the customer, with its store or channel label (`customers.view`). */
export const CustomerTimelineChannelIdEntry = z.object({
  kind: z.literal('channel_id_added'),
  id: z.uuid(),
  at: Timestamp,
  channelIdKind: CustomerExternalIdKind,
  externalId: z.string(),
  storeCode: z.string().nullable(),
  storeName: LocalizedText.nullable(),
  channelCode: z.string().nullable(),
  channelName: LocalizedText.nullable(),
});
/** The validated shape of `CustomerTimelineChannelIdEntry`. */
export type CustomerTimelineChannelIdEntry = z.infer<typeof CustomerTimelineChannelIdEntry>;

/** The customer's current flag at its set time (`customers.view`); `id` is the record holding it. */
export const CustomerTimelineFlagEntry = z.object({
  kind: z.literal('flag'),
  id: z.uuid(),
  at: Timestamp,
  flagKind: CustomerRiskFlag,
  source: CustomerRiskFlagSource,
  setByName: z.string().nullable(),
  note: z.string().nullable(),
});
/** The validated shape of `CustomerTimelineFlagEntry`. */
export type CustomerTimelineFlagEntry = z.infer<typeof CustomerTimelineFlagEntry>;

/** One timeline entry, a union by `kind` (spec 0014 AC-14). */
export const CustomerTimelineEntry = z.discriminatedUnion('kind', [
  CustomerTimelineOrderEntry,
  CustomerTimelineMergeEntry,
  CustomerTimelineUnmergeEntry,
  CustomerTimelinePhoneEntry,
  CustomerTimelineChannelIdEntry,
  CustomerTimelineFlagEntry,
]);
/** The validated shape of `CustomerTimelineEntry`. */
export type CustomerTimelineEntry = z.infer<typeof CustomerTimelineEntry>;

/**
 * One page of the timeline, newest first: `at` descending, then the source key, then the entry
 * id descending, across every source. `nextCursor` is null on the last page.
 */
export const CustomerTimelinePage = z.object({
  items: z.array(CustomerTimelineEntry),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `CustomerTimelinePage`. */
export type CustomerTimelinePage = z.infer<typeof CustomerTimelinePage>;
