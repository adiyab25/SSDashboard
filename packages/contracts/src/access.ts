import { z } from 'zod';

// Spec 0008: hats, permissions, and the cost grant. The permission matrix is data, defined once
// here and used by the api (which enforces it) and the web (which only hides what a person cannot
// use). It is fixed in code in this version: no brand edits it on a screen (AC-1).

/** The hats a brand's own people wear (AC-1). Only these may own a task (AC-17, `tasks.owner_hat`). */
export const InternalHat = z.enum(['support', 'operations', 'warehouse', 'manager']);
/** The validated shape of `InternalHat`, as the api and web see it after parsing. */
export type InternalHat = z.infer<typeof InternalHat>;

/** The hats of people outside the brand: the freelance media buyer and a consignment partner (AC-1). */
export const ExternalHat = z.enum(['media_buyer', 'partner']);
/** The validated shape of `ExternalHat`, as the api and web see it after parsing. */
export type ExternalHat = z.infer<typeof ExternalHat>;

/** Every hat, exactly six (AC-1). Matches the `hat_assignments_hat_known` database check. */
export const Hat = z.enum([...InternalHat.options, ...ExternalHat.options]);
/** The validated shape of `Hat`, as the api and web see it after parsing. */
export type Hat = z.infer<typeof Hat>;

/** The audiences a permission or a hat belongs to (spec 0007, section 2). */
export const AccessAudience = z.enum(['staff', 'partner']);
/** The validated shape of `AccessAudience`, as the api and web see it after parsing. */
export type AccessAudience = z.infer<typeof AccessAudience>;

/**
 * Every permission a route can need, the catalog of the permission matrix. A route declares
 * permissions only from this list (`permission.spec.ts` in the api fails otherwise).
 */
export const Permission = z.enum([
  'orders.view',
  'orders.confirm',
  'orders.gift',
  'customers.view',
  'customers.merge',
  'customers.flag',
  'exchanges.handle',
  'refunds.approve',
  'fulfillment.work',
  'stock.view',
  'stock.receive',
  'stock.correct',
  'catalog.edit',
  'catalog.manage',
  'channels.map',
  'settlement.work',
  'settlement.close',
  'exports.run',
  'partners.manage',
  'tasks.work',
  'tasks.assign',
  'reports.view',
  'campaigns.view',
  'people.manage',
  'settings.manage',
  'audit.read',
  'audit.undo',
  'audit.export',
  'partner.view_own',
  'partner.submit_sales',
  'cost.view',
]);
/** The validated shape of `Permission`, as the api and web see it after parsing. */
export type Permission = z.infer<typeof Permission>;

/** What the matrix says about one permission besides who holds it. */
export interface PermissionTraits {
  /** The one audience whose routes may declare it. */
  audience: AccessAudience;
  /**
   * True when it reaches customer personal data (Law 151, the `P` column). No external hat may
   * hold one (AC-8).
   */
  personal: boolean;
}

const staff = (personal: boolean): PermissionTraits => ({ audience: 'staff', personal });

/** Each permission's audience and personal data flag, as the permission matrix of spec 0008 marks them. */
export const PERMISSIONS: Readonly<Record<Permission, PermissionTraits>> = {
  'orders.view': staff(true),
  'orders.confirm': staff(true),
  'orders.gift': staff(false),
  'customers.view': staff(true),
  'customers.merge': staff(true),
  'customers.flag': staff(true),
  'exchanges.handle': staff(true),
  'refunds.approve': staff(true),
  'fulfillment.work': staff(true),
  'stock.view': staff(false),
  'stock.receive': staff(false),
  'stock.correct': staff(false),
  'catalog.edit': staff(false),
  'catalog.manage': staff(false),
  'channels.map': staff(false),
  'settlement.work': staff(true),
  'settlement.close': staff(false),
  'exports.run': staff(false),
  'partners.manage': staff(false),
  'tasks.work': staff(true),
  'tasks.assign': staff(false),
  'reports.view': staff(false),
  'campaigns.view': staff(false),
  'people.manage': staff(false),
  'settings.manage': staff(false),
  'audit.read': staff(true),
  'audit.undo': staff(true),
  'audit.export': staff(true),
  'partner.view_own': { audience: 'partner', personal: false },
  'partner.submit_sales': { audience: 'partner', personal: false },
  'cost.view': staff(false),
};

/** The audience each hat signs in to: `partner` for the partner hat, `staff` for every other (AC-10). */
export const HAT_AUDIENCE: Readonly<Record<Hat, AccessAudience>> = {
  support: 'staff',
  operations: 'staff',
  warehouse: 'staff',
  manager: 'staff',
  media_buyer: 'staff',
  partner: 'partner',
};

/**
 * What each hat lets a person do: the permission matrix of spec 0008 (AC-1). `cost.view` is in no
 * hat (AC-6); it exists only as an extra grant. Never add a personal permission to an external hat
 * (AC-8): the matrix test fails.
 */
export const HAT_PERMISSIONS: Readonly<Record<Hat, readonly Permission[]>> = {
  support: [
    'orders.view',
    'orders.confirm',
    'customers.view',
    'customers.merge',
    'customers.flag',
    'exchanges.handle',
    'stock.view',
    'tasks.work',
  ],
  operations: [
    'orders.view',
    'orders.confirm',
    'customers.view',
    'customers.merge',
    'customers.flag',
    'exchanges.handle',
    'refunds.approve',
    'fulfillment.work',
    'stock.view',
    'stock.receive',
    'catalog.edit',
    'channels.map',
    'settlement.work',
    'settlement.close',
    'exports.run',
    'partners.manage',
    'tasks.work',
    'tasks.assign',
    'reports.view',
    'campaigns.view',
  ],
  warehouse: [
    'orders.view',
    'fulfillment.work',
    'stock.view',
    'stock.receive',
    'catalog.edit',
    'tasks.work',
  ],
  manager: [
    'orders.view',
    'orders.confirm',
    'orders.gift',
    'customers.view',
    'customers.merge',
    'customers.flag',
    'exchanges.handle',
    'refunds.approve',
    'fulfillment.work',
    'stock.view',
    'stock.receive',
    'stock.correct',
    'catalog.edit',
    'catalog.manage',
    'channels.map',
    'settlement.work',
    'settlement.close',
    'exports.run',
    'partners.manage',
    'tasks.work',
    'tasks.assign',
    'reports.view',
    'campaigns.view',
    'people.manage',
    'settings.manage',
    'audit.read',
    'audit.undo',
    'audit.export',
  ],
  media_buyer: ['campaigns.view'],
  partner: ['partner.view_own', 'partner.submit_sales'],
};

/**
 * The permissions that can be granted to one person on top of their hats. Matches the
 * `permission_grants_permission_grantable` database check; a later grant widens both together.
 */
export const GrantablePermission = z.enum(['cost.view']);
/** The validated shape of `GrantablePermission`, as the api and web see it after parsing. */
export type GrantablePermission = z.infer<typeof GrantablePermission>;

/**
 * Where the cost switch starts when a manager first gives a person a hat (AC-7, owner question 1):
 * on for `manager` and `operations`, off for the rest. Only a form prefill; the partner hat can
 * never hold cost, so it has no entry.
 */
export const COST_VIEW_DEFAULT: Readonly<Record<Exclude<Hat, 'partner'>, boolean>> = {
  support: false,
  operations: true,
  warehouse: false,
  manager: true,
  media_buyer: false,
};

/**
 * Every answer field that carries cost or value (AC-6). Without `cost.view`, no api answer holds a
 * field with one of these names, on any route; each response type's serializer removes them.
 * A new cost field joins this list; a sale amount must never use one of these names.
 */
export const COST_FIELD_KEYS = [
  'unitCost',
  'lineTotal',
  'referenceValue',
  'avgUnitCost',
  'totalValue',
  'totalCost',
  // Spec 0012, AC-12 and AC-16: a variant's cost in force on the style page (an object).
  'cost',
] as const;
/** One of {@link COST_FIELD_KEYS}. */
export type CostFieldKey = (typeof COST_FIELD_KEYS)[number];

/**
 * A person's effective permissions: the union of every hat's permissions plus their extra grants,
 * sorted and without repeats (AC-1). Pure; it never decides whether a grant is allowed.
 */
export function permissionsFor(hats: readonly Hat[], grants: readonly Permission[]): Permission[] {
  const all = new Set<Permission>(grants);
  for (const hat of hats) for (const permission of HAT_PERMISSIONS[hat]) all.add(permission);
  return [...all].sort();
}

/**
 * The hats a staff person can be given on `/api/staff` (AC-12, AC-14): the four internal hats and
 * `media_buyer`. `partner` is never given there; a partner user comes only through
 * `/api/partner-users`. The web offers exactly these on the hats dialog.
 */
export const StaffHat = z.enum([...InternalHat.options, 'media_buyer']);
/** The validated shape of `StaffHat`, as the api and web see it after parsing. */
export type StaffHat = z.infer<typeof StaffHat>;

/**
 * The hats of an access change or a new staff person as the api reads them: any catalog hat, at
 * most once each, so the api answers the spec's stable codes itself (422 `NO_HAT` for none,
 * `HAT_CONFLICT` for `partner` on a staff route or beside another hat) instead of a generic
 * validation failure. The web sends only {@link StaffHat} values.
 */
export const RequestedHats = z
  .array(Hat)
  .max(Hat.options.length)
  .refine((hats) => new Set(hats).size === hats.length, 'Each hat at most once');

/**
 * The manager's optional reason for an access change, trimmed, up to 500 characters (AC-13). Empty
 * text is no reason. Required by the api when the change takes `manager` away (spec 0010, action
 * `hat.revoked`): 422 `REASON_REQUIRED`.
 */
export const AccessReason = z
  .string()
  .trim()
  .max(500)
  .transform((value) => value || undefined);

/**
 * `PUT /api/staff/:id/access` (AC-12): the person's whole new access set, replacing the old one.
 * `updatedAt` is the `updatedAt` of the staff detail read before the change; a mismatch is 409
 * `STALE_RECORD`. A cost change needs the actor to hold `cost.view` (403 `FORBIDDEN`), and nobody
 * changes their own hats or cost (409 `SELF_HAT_CHANGE`).
 */
export const AccessRequest = z.object({
  hats: RequestedHats,
  costView: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
  reason: AccessReason.optional(),
});
/** The validated shape of `AccessRequest`, as the api and web see it after parsing. */
export type AccessRequest = z.infer<typeof AccessRequest>;

/**
 * What a person holds, before or after an access change, as spec 0008 AC-13 names it: the hats,
 * whether they hold the `cost.view` grant, and the partner account of a partner user (null for
 * staff). The `before` and `after` of the `HatsChanged` event and of the audit entry. Ids only:
 * never a name, an email or a phone.
 */
export const AccessHolding = z.object({
  hats: z.array(Hat),
  costView: z.boolean(),
  partnerAccountId: z.uuid().nullable(),
});
/** The validated shape of `AccessHolding`, as the api and web see it after parsing. */
export type AccessHolding = z.infer<typeof AccessHolding>;

/**
 * The stable codes an access change answers with, besides the shared ones (AC-12, spec 0008
 * errors). `UNKNOWN_PARTNER_ACCOUNT` is the partner user's move to an account that is not a
 * consignment partner (`PUT /api/partner-users/:id/access`).
 */
export const AccessErrorCode = z.enum([
  'FORBIDDEN',
  'NOT_FOUND',
  'STALE_RECORD',
  'SELF_HAT_CHANGE',
  'LAST_ADMIN',
  'HAT_CONFLICT',
  'GRANT_NOT_ALLOWED',
  'NO_HAT',
  'REASON_REQUIRED',
  'UNKNOWN_PARTNER_ACCOUNT',
]);
/** The validated shape of `AccessErrorCode`, as the api and web see it after parsing. */
export type AccessErrorCode = z.infer<typeof AccessErrorCode>;
