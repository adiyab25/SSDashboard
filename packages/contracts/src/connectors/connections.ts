import { z } from 'zod';
import { LocalizedText } from '../localized-text.js';
import { AppOwner } from './connection-config.js';
import {
  ConnectionHealth,
  ConnectionProvider,
  ConnectionStatus,
  SyncRunStatus,
} from './connector-enums.js';

/**
 * The connection routes' shapes (spec 0015, *API surface*): the connect body, the list item, the
 * detail, and the health reason and warning codes. No shape here ever carries a credential, a
 * token, or any part of a secret: a screen shows only that keys are set and the last 4 characters
 * of the client id (AC-2).
 */

/**
 * C0 and C1 control characters and the bidirectional marks, embeddings, overrides, and isolates
 * (ALM, LRM, RLM, LRE to RLO, LRI to PDI) a typed label must not carry (security review L11): shown
 * in the list, the detail, and the audit trail, they could reorder or hide text.
 */
export const CONTROL_OR_BIDI_PATTERN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

/** A Shopify shop domain (`<name>.myshopify.com`), the `connections_shop_domain_shape` check. */
export const SHOPIFY_SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * A store code (`ChannelsService.createShopifyStore`): 1 to 32 upper case letters, digits, `_` or
 * `-`, starting with a letter or digit. A Shopify store's channel carries the same code.
 */
export const STORE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

/**
 * Why a connection is `failing` or `degraded` (spec 0015 AC-1, AC-3, *State transitions*).
 * Task 6 (connect) sets the first ten: the AC-1 codes, plus `CREDENTIALS_UNREADABLE` (the sealed
 * keys no longer open, so the owner types them again), `SHOP_UNAVAILABLE` and `ACCESS_DENIED`
 * (Shopify refused the shop or a read), `CONNECT_REJECTED` (any other refusal the connect check
 * cannot name), and `WEBHOOKS_MISSING` (a subscription could not be registered). The rest are the
 * later degraded codes of *State transitions*, listed so a screen can label every stored value.
 */
export const ConnectionHealthReason = z.enum([
  'APP_NOT_INSTALLED',
  'APP_ORGANIZATION_MISMATCH',
  'CREDENTIALS_REJECTED',
  'SCOPES_MISSING',
  'PROTECTED_DATA_MISSING',
  'CURRENCY_MISMATCH',
  'PUBLIC_URL_NOT_HTTPS',
  'CREDENTIALS_UNREADABLE',
  'SHOP_UNAVAILABLE',
  'ACCESS_DENIED',
  'CONNECT_REJECTED',
  'WEBHOOKS_MISSING',
  'SWEEP_LATE',
  'READS_FAILING',
  'NO_STOCK_LOCATION',
  'STOCK_AT_UNMAPPED_LOCATION',
  'API_VERSION_FELL_FORWARD',
]);
/** One ConnectionHealthReason value. */
export type ConnectionHealthReason = z.infer<typeof ConnectionHealthReason>;

/**
 * Warnings that keep health `ok` but show on the connection (AC-1, AC-25): the shop's time zone
 * is not the install's `timezone` setting, the Shopify app is owned by a person's account, or
 * Shopify answered with a newer API version than the pinned one (set and cleared by the connect
 * and inbox jobs).
 */
export const ConnectionWarning = z.enum([
  'SHOP_TIMEZONE_DIFFERS',
  'APP_OWNED_BY_PERSON',
  'API_VERSION_FELL_FORWARD',
]);
/** One ConnectionWarning value. */
export type ConnectionWarning = z.infer<typeof ConnectionWarning>;

/**
 * `POST /api/connections/shopify` (`settings.manage`, AC-1). The shop domain is trimmed and lower
 * cased before its shape is checked; a domain of the wrong shape answers 422
 * `INVALID_SHOP_DOMAIN`, any other bad field 422 `INVALID_BODY` (a label with a control or direction
 * character included). The client id and secret are typed
 * by the owner (Q-13.8) and never come back in any answer.
 */
export const ConnectShopifyBody = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((label) => !CONTROL_OR_BIDI_PATTERN.test(label), {
      message: 'The label has a control or direction character',
    }),
  storeCode: z.string().trim().regex(STORE_CODE_PATTERN),
  shopDomain: z.string().trim().toLowerCase().max(255).regex(SHOPIFY_SHOP_DOMAIN_PATTERN),
  clientId: z.string().trim().min(1).max(255),
  clientSecret: z.string().trim().min(1).max(255),
  appOwner: AppOwner,
});
/** The parsed ConnectShopifyBody. */
export type ConnectShopifyBody = z.infer<typeof ConnectShopifyBody>;

/** The 201 answer of `POST /api/connections/shopify`: the new connection, checks still running. */
export const ConnectShopifyResponse = z.object({
  id: z.uuid(),
  health: z.literal('connecting'),
});
/** The parsed ConnectShopifyResponse. */
export type ConnectShopifyResponse = z.infer<typeof ConnectShopifyResponse>;

/**
 * The stable error codes of the connect and check routes (spec 0015 *API surface*): 409
 * `SHOP_ALREADY_CONNECTED`, `STORE_CODE_TAKEN`, `CONNECTION_ARCHIVED`; 422 `INVALID_SHOP_DOMAIN`,
 * `INVALID_BODY`; 404 `NOT_FOUND`; 400 `INVALID_QUERY` for a bad list cursor.
 */
export const ConnectionErrorCode = z.enum([
  'SHOP_ALREADY_CONNECTED',
  'STORE_CODE_TAKEN',
  'CONNECTION_ARCHIVED',
  'INVALID_SHOP_DOMAIN',
  'INVALID_BODY',
  'NOT_FOUND',
  'INVALID_QUERY',
]);
/** One ConnectionErrorCode value. */
export type ConnectionErrorCode = z.infer<typeof ConnectionErrorCode>;

/** `GET /api/connections` query: a keyset cursor and a page size (50 by default, at most 100). */
export const ConnectionListQuery = z.object({
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** The parsed ConnectionListQuery. */
export type ConnectionListQuery = z.infer<typeof ConnectionListQuery>;

/** A UTC instant as the api issues it. */
const Instant = z.iso.datetime({ offset: true });

/** When a connection last heard from its account (the freshness columns), each null until then. */
export const ConnectionFreshness = z.object({
  lastInboundAt: Instant.nullable(),
  lastOrderAt: Instant.nullable(),
  lastSweepAt: Instant.nullable(),
});
/** The parsed ConnectionFreshness. */
export type ConnectionFreshness = z.infer<typeof ConnectionFreshness>;

/** One row of `GET /api/connections`: never credentials. */
export const ConnectionListItem = z.object({
  id: z.uuid(),
  label: z.string(),
  provider: ConnectionProvider,
  /** The store code, or null for a connection without a store (a carrier serving every store). */
  storeCode: z.string().nullable(),
  status: ConnectionStatus,
  health: ConnectionHealth,
  healthReason: ConnectionHealthReason.nullable(),
  healthWarnings: z.array(ConnectionWarning),
  freshness: ConnectionFreshness,
});
/** The parsed ConnectionListItem. */
export type ConnectionListItem = z.infer<typeof ConnectionListItem>;

/** `GET /api/connections`: one page, newest first, and the cursor of the next page or null. */
export const ConnectionListResponse = z.object({
  items: z.array(ConnectionListItem),
  nextCursor: z.string().nullable(),
});
/** The parsed ConnectionListResponse. */
export type ConnectionListResponse = z.infer<typeof ConnectionListResponse>;

/**
 * The last connect check of a connection (its newest `connect` sync run): how it ended, the error
 * code when it failed, the missing scope handles for `SCOPES_MISSING`, how many of the webhook
 * topics are subscribed, and how many Shopify locations the store has (online ones apart).
 */
export const ConnectionCheckView = z.object({
  runId: z.uuid(),
  status: SyncRunStatus,
  startedAt: Instant,
  finishedAt: Instant.nullable(),
  errorCode: z.string().nullable(),
  missingScopes: z.array(z.string()),
  webhookTopicsSubscribed: z.number().int().nonnegative(),
  locations: z.number().int().nonnegative(),
  onlineLocations: z.number().int().nonnegative(),
});
/** The parsed ConnectionCheckView. */
export type ConnectionCheckView = z.infer<typeof ConnectionCheckView>;

/**
 * `GET /api/connections/:id` (`settings.manage`). Never credentials: `credentials.set` says keys
 * are stored and `clientIdLast4` is the only part of them a screen shows (AC-2).
 */
export const ConnectionDetail = z.object({
  id: z.uuid(),
  label: z.string(),
  provider: ConnectionProvider,
  status: ConnectionStatus,
  store: z
    .object({
      id: z.uuid(),
      code: z.string(),
      name: LocalizedText,
      publicName: LocalizedText,
    })
    .nullable(),
  shopDomain: z.string().nullable(),
  health: ConnectionHealth,
  healthReason: ConnectionHealthReason.nullable(),
  healthWarnings: z.array(ConnectionWarning),
  healthChangedAt: Instant.nullable(),
  apiVersion: z.string().nullable(),
  appOwner: AppOwner.nullable(),
  shopTimezone: z.string().nullable(),
  credentials: z.object({
    set: z.boolean(),
    clientIdLast4: z.string().max(4).nullable(),
  }),
  freshness: ConnectionFreshness,
  lastCheck: ConnectionCheckView.nullable(),
  createdAt: Instant,
  updatedAt: Instant,
});
/** The parsed ConnectionDetail. */
export type ConnectionDetail = z.infer<typeof ConnectionDetail>;
