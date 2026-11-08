import type { AppOwner, ConnectionHealthReason, ConnectionWarning } from '@ssdashboard/contracts';
import { SHOPIFY_REQUIRED_SCOPES } from './shopify-app.js';

/**
 * Whether the most recent order came back with its protected customer fields (spec 0015,
 * *Protected customer data*): each value reduced to present or not at once; the values themselves
 * never reach this type.
 */
export interface LatestOrderFields {
  readonly hasName: boolean;
  readonly hasPhone: boolean;
  readonly hasAddress: boolean;
}

/** What the connect job learned, the input of `decideConnectHealth`. */
export interface ConnectFacts {
  /** The scope handles the store granted the app. */
  readonly grantedScopes: readonly string[];
  /**
   * The most recent order's protected fields, or null when the store has no order yet (the first
   * order applied runs the check then, task 7) or the reads stopped before it.
   */
  readonly latestOrder: LatestOrderFields | null;
  /** The shop's currency (`Shop.currencyCode`). */
  readonly shopCurrency: string;
  /** The install's `currency` setting. */
  readonly installCurrency: string;
  /** The shop's IANA time zone (`Shop.ianaTimezone`). */
  readonly shopTimezone: string;
  /** The install's `timezone` setting. */
  readonly installTimezone: string;
  /** Who owns the app, as the manager said at connect. */
  readonly appOwner: AppOwner;
  /** Whether the webhook address (`PUBLIC_URL` based) is https. */
  readonly hookAddressIsHttps: boolean;
}

/** The connect check's verdict before the webhook subscriptions are registered. */
export interface ConnectVerdict {
  /** `ok`, or `failing` with exactly one reason. */
  readonly health: 'ok' | 'failing';
  /** The one failing code, or null when `ok`. */
  readonly reason: ConnectionHealthReason | null;
  /** Warnings shown beside the health; they never change it. */
  readonly warnings: readonly ConnectionWarning[];
  /** The required handles the store did not grant, in the required list's order. */
  readonly missingScopes: readonly string[];
}

/** The required scope handles missing from a granted list, in `SHOPIFY_REQUIRED_SCOPES` order. */
export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return SHOPIFY_REQUIRED_SCOPES.filter((handle) => !have.has(handle));
}

/** The warnings of AC-1: a shop time zone other than the install's, and a person owned app. */
export function connectWarnings(
  facts: Pick<ConnectFacts, 'shopTimezone' | 'installTimezone' | 'appOwner'>,
): ConnectionWarning[] {
  const warnings: ConnectionWarning[] = [];
  if (facts.shopTimezone !== facts.installTimezone) warnings.push('SHOP_TIMEZONE_DIFFERS');
  if (facts.appOwner === 'person') warnings.push('APP_OWNED_BY_PERSON');
  return warnings;
}

/**
 * The health a passed read gives a connection (spec 0015 AC-1, *State transitions*): `failing`
 * with the first code that applies, in this order: `SCOPES_MISSING` (with the handles),
 * `PROTECTED_DATA_MISSING` (the latest order lacks a ship to name, phone, or address line; never
 * with no order yet), `CURRENCY_MISMATCH` (the shop's currency is not the install's),
 * `PUBLIC_URL_NOT_HTTPS` (Shopify could not deliver webhooks). Otherwise `ok`. The warnings are
 * computed either way and never change the health. Pure: the token errors
 * (`APP_NOT_INSTALLED`, `APP_ORGANIZATION_MISMATCH`, `CREDENTIALS_REJECTED`) are thrown by the
 * client before any fact exists and are mapped by the job.
 */
export function decideConnectHealth(facts: ConnectFacts): ConnectVerdict {
  const warnings = connectWarnings(facts);
  const missing = missingScopes(facts.grantedScopes);
  const failing = (reason: ConnectionHealthReason): ConnectVerdict => ({
    health: 'failing',
    reason,
    warnings,
    missingScopes: missing,
  });
  if (missing.length > 0) return failing('SCOPES_MISSING');
  const order = facts.latestOrder;
  if (order && !(order.hasName && order.hasPhone && order.hasAddress)) {
    return failing('PROTECTED_DATA_MISSING');
  }
  if (facts.shopCurrency !== facts.installCurrency) return failing('CURRENCY_MISMATCH');
  if (!facts.hookAddressIsHttps) return failing('PUBLIC_URL_NOT_HTTPS');
  return { health: 'ok', reason: null, warnings, missingScopes: [] };
}
