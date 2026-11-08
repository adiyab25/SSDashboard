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

/** What a hook request offers before it is verified: the path id, two headers, the raw bytes. */
export interface ShopifyHookAttempt {
  /** The `:connectionId` of the path, unchecked. */
  readonly connectionId: string;
  /** `X-Shopify-Hmac-SHA256`. */
  readonly signature: string | undefined;
  /** `X-Shopify-Shop-Domain`. */
  readonly shopDomain: string | undefined;
  /** The raw body, read by the hook body reader before any parser. */
  readonly rawBody: Buffer;
}

interface ConnectionRow extends Record<string, unknown> {
  id: string;
  status: string;
  shop_domain: string | null;
  credentials_ciphertext: Buffer | null;
  credentials_key_version: number | null;
}

interface CachedSecret {
  readonly secret: Buffer;
  readonly expiresAt: number;
}

/**
 * Proves a Shopify webhook delivery before anything is parsed (spec 0015 AC-4): the path's
 * connection exists, is a Shopify connection that is not archived, `X-Shopify-Shop-Domain` equals
 * its shop domain, and the HMAC SHA256 of the raw bytes, keyed with its webhook secret (the client
 * secret of `client_credentials`, the API secret of a legacy `access_token`), matches
 * `X-Shopify-Hmac-SHA256` in constant time. Every failure answers the same null, so the route
 * gives the same 401 whether the id is malformed, unknown, archived, the shop wrong, or the
 * signature missing or wrong; a wrong shop or signature on a live connection counts one failure on
 * the connection, at most one write per connection per minute.
 *
 * The secret is opened once and kept in this process's memory for 5 minutes per (connection, key
 * version), so a key rotation is picked up at once. It never logs, returns, or throws a secret, a
 * signature, a header, or a body byte: its one log line carries the connection id and a code.
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

  /** The proof of a good delivery, or null for every kind of failure (see the class). */
  async verify(
    attempt: ShopifyHookAttempt,
    now: number = Date.now(),
  ): Promise<ShopifyHookProof | null> {
    if (!UUID.test(attempt.connectionId)) return null;
    const { rows } = await this.connection.db.execute<ConnectionRow>(sql`
      SELECT id, status, shop_domain, credentials_ciphertext, credentials_key_version
      FROM connections
      WHERE id = ${attempt.connectionId}::uuid AND provider = 'shopify'`);
    const row = rows[0];
    if (!row || row.status === 'archived') return null;
    if (!row.shop_domain || !row.credentials_ciphertext || row.credentials_key_version === null) {
      return null;
    }
    const shop = attempt.shopDomain?.trim().toLowerCase();
    let secret: Buffer | null = null;
    if (shop === row.shop_domain) {
      secret = this.secretOf(row, now);
    }
    if (secret === null || !verifyShopifySignature(attempt.rawBody, attempt.signature, secret)) {
      await this.countFailure(row.id, now);
      return null;
    }
    return { provider: 'shopify', connectionId: row.id };
  }

  /** Forgets every cached secret (a test, or after a key replacement in this process). */
  forgetSecrets(): void {
    this.secrets.clear();
  }

  /** The cached or freshly opened webhook secret; null when the stored value does not open. */
  private secretOf(row: ConnectionRow, now: number): Buffer | null {
    const key = `${row.id}:${row.credentials_key_version}`;
    const cached = this.secrets.get(key);
    if (cached && cached.expiresAt > now) return cached.secret;
    if (cached) {
      cached.secret.fill(0);
      this.secrets.delete(key);
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
      this.secrets.set(key, { secret, expiresAt: now + HOOK_SECRET_CACHE_MS });
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
