import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { ConnectionSecrets, ConnectionSecretsError } from '../connections/connection-secrets.js';
import { verifyShopifySignature } from './shopify-signature.js';

/** How long an opened webhook secret stays in this process's memory (spec 0015 Inbound item 1). */
export const HOOK_SECRET_CACHE_MS = 5 * 60_000;

/** At most one failure count write per connection in this window (AC-4). */
export const HOOK_FAILURE_WRITE_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The proof a verified delivery carries on `request.hook` for the audience guard and the route. */
export interface ShopifyHookProof {
  readonly provider: 'shopify';
  /** The connection the signature was checked against. */
  readonly connectionId: string;
}

/** What a hook request offers before its body is read: the path id and the shop header. */
export interface ShopifyHookAddress {
  /** The `:connectionId` of the path, unchecked. */
  readonly connectionId: string;
  /** `X-Shopify-Shop-Domain`. */
  readonly shopDomain: string | undefined;
}

/** What a hook request offers in full: the address, the signature header, the raw bytes. */
export interface ShopifyHookAttempt extends ShopifyHookAddress {
  /** `X-Shopify-Hmac-SHA256`. */
  readonly signature: string | undefined;
  /** The raw body, read by the hook body reader before any parser. */
  readonly rawBody: Buffer;
}

/** The connection columns the verifier reads; the ciphertext stays a buffer in memory only. */
export interface ShopifyHookConnectionRow extends Record<string, unknown> {
  id: string;
  status: string;
  shop_domain: string | null;
  credentials_ciphertext: Buffer | null;
  credentials_key_version: number | null;
  /** `credentials_updated_at` as text: part of the secret cache stamp (security review L5). */
  credentials_stamp: string | null;
}

/**
 * A live connection a delivery is addressed to, found before the body is read. Only
 * `ShopifyHookVerifier.prove` reads its row.
 */
export interface ShopifyHookTarget {
  readonly row: Readonly<ShopifyHookConnectionRow>;
}

/** One opened secret and what it was opened from. */
interface CachedSecret {
  /** The key version and the credentials stamp the secret was opened from. */
  readonly stamp: string;
  readonly secret: Buffer;
  readonly expiresAt: number;
}

/**
 * Proves a Shopify webhook delivery before anything is parsed (spec 0015 AC-4), in two steps so
 * the hook can refuse before it reads a body byte (security review M1):
 *
 * 1. `target` (no body): the path id is a UUID of a Shopify connection that is not archived and
 *    has its shop and credentials, and `X-Shopify-Shop-Domain` equals its shop domain.
 * 2. `prove` (the raw bytes): the HMAC SHA256 of the raw bytes, keyed with its webhook secret (the
 *    client secret of `client_credentials`, the API secret of a legacy `access_token`), matches
 *    `X-Shopify-Hmac-SHA256` in constant time.
 *
 * Every failure answers the same null, so the hook gives the same empty 401 whether the id is
 * malformed, unknown, archived, the shop wrong, or the signature missing or wrong; a wrong shop or
 * signature on a live connection counts one failure on the connection, at most one write per
 * connection per minute.
 *
 * The secret is opened once and kept in this process's memory for 5 minutes per connection,
 * stamped with the key version and `credentials_updated_at`, so both a `CONNECTOR_SECRET_KEY`
 * rotation and a replaced client secret are used at once. It never logs, returns, or throws a
 * secret, a signature, a header, or a body byte: its one log line carries the connection id and a
 * code.
 */
@Injectable()
export class ShopifyHookVerifier {
  private readonly logger = new Logger('ShopifyHook');
  private readonly secrets = new Map<string, CachedSecret>();
  private readonly lastFailureWrite = new Map<string, number>();

  /** Takes the database and the secrets service (the only place a stored secret opens). */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ConnectionSecrets) private readonly sealed: ConnectionSecrets,
  ) {}

  /** Step 1 (see the class): the live connection a delivery is addressed to, or null. */
  async target(
    address: ShopifyHookAddress,
    now: number = Date.now(),
  ): Promise<ShopifyHookTarget | null> {
    if (!UUID.test(address.connectionId)) return null;
    const { rows } = await this.connection.db.execute<ShopifyHookConnectionRow>(sql`
      SELECT id, status, shop_domain, credentials_ciphertext, credentials_key_version,
             credentials_updated_at::text AS credentials_stamp
      FROM connections
      WHERE id = ${address.connectionId}::uuid AND provider = 'shopify'`);
    const row = rows[0];
    if (!row || row.status === 'archived') return null;
    if (!row.shop_domain || !row.credentials_ciphertext || row.credentials_key_version === null) {
      return null;
    }
    if (address.shopDomain?.trim().toLowerCase() !== row.shop_domain) {
      await this.countFailure(row.id, now);
      return null;
    }
    return { row };
  }

  /** Step 2 (see the class): the proof of a good signature on the raw bytes, or null. */
  async prove(
    target: ShopifyHookTarget,
    signature: string | undefined,
    rawBody: Buffer,
    now: number = Date.now(),
  ): Promise<ShopifyHookProof | null> {
    const secret = this.secretOf(target.row, now);
    if (secret === null || !verifyShopifySignature(rawBody, signature, secret)) {
      await this.countFailure(target.row.id, now);
      return null;
    }
    return { provider: 'shopify', connectionId: target.row.id };
  }

  /** Both steps at once, for a caller that already holds the body (see the class). */
  async verify(
    attempt: ShopifyHookAttempt,
    now: number = Date.now(),
  ): Promise<ShopifyHookProof | null> {
    const found = await this.target(attempt, now);
    return found ? this.prove(found, attempt.signature, attempt.rawBody, now) : null;
  }

  /** Forgets every cached secret (a test, or after a key replacement in this process). */
  forgetSecrets(): void {
    for (const cached of this.secrets.values()) cached.secret.fill(0);
    this.secrets.clear();
  }

  /** The cached or freshly opened webhook secret; null when the stored value does not open. */
  private secretOf(row: Readonly<ShopifyHookConnectionRow>, now: number): Buffer | null {
    const stamp = `${row.credentials_key_version}:${row.credentials_stamp ?? ''}`;
    const cached = this.secrets.get(row.id);
    if (cached && cached.stamp === stamp && cached.expiresAt > now) return cached.secret;
    if (cached) {
      cached.secret.fill(0);
      this.secrets.delete(row.id);
    }
    try {
      const credentials = this.sealed.open(
        {
          ciphertext: row.credentials_ciphertext as Buffer,
          keyVersion: row.credentials_key_version as number,
        },
        row.id,
      );
      const text =
        credentials.kind === 'client_credentials'
          ? credentials.clientSecret
          : credentials.apiSecret;
      const secret = Buffer.from(text, 'utf8');
      this.secrets.set(row.id, { stamp, secret, expiresAt: now + HOOK_SECRET_CACHE_MS });
      return secret;
    } catch (error) {
      if (!(error instanceof ConnectionSecretsError)) throw error;
      this.logger.warn(`hook connection=${row.id} refused=${error.code}`);
      return null;
    }
  }

  /** Counts one failure on a live connection, at most one write per connection per minute. */
  private async countFailure(connectionId: string, now: number): Promise<void> {
    const last = this.lastFailureWrite.get(connectionId);
    if (last !== undefined && now - last < HOOK_FAILURE_WRITE_MS) return;
    this.lastFailureWrite.set(connectionId, now);
    await this.connection.db.execute(sql`
      UPDATE connections
      SET hook_auth_failures = hook_auth_failures + 1, last_hook_auth_failure_at = now()
      WHERE id = ${connectionId}::uuid
        AND (last_hook_auth_failure_at IS NULL
             OR last_hook_auth_failure_at <= now() - interval '1 minute')`);
  }
}
