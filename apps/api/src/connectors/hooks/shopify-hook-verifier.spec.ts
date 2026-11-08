import { createHmac, randomBytes } from 'node:crypto';
import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it } from 'vitest';
import { ConnectionSecrets } from '../connections/connection-secrets.js';
import { ShopifyHookVerifier, type ShopifyHookConnectionRow } from './shopify-hook-verifier.js';

// Security review L5 and M1: the secret cache follows a replaced client secret at once, and the
// pre-body step refuses without opening anything. A fake database answers the connection row.

const KEY = randomBytes(32).toString('base64');
const CONNECTION = '00000000-0000-4000-8000-0000000000a1';
const SHOP = 'fixture-store.myshopify.com';
const BODY = Buffer.from('{"admin_graphql_api_id":"gid://shopify/Order/1"}', 'utf8');

const sign = (secret: string) => createHmac('sha256', secret).update(BODY).digest('base64');

/** A verifier on a fake database whose one connection row the test can replace. */
function verifierWith(secrets: ConnectionSecrets) {
  const state: { row: ShopifyHookConnectionRow | null; reads: number; writes: number } = {
    row: null,
    reads: 0,
    writes: 0,
  };
  const database = {
    db: {
      execute: (query: { queryChunks?: unknown[] }) => {
        const text = JSON.stringify(query.queryChunks ?? '');
        if (text.includes('UPDATE connections')) {
          state.writes += 1;
          return Promise.resolve({ rows: [] });
        }
        state.reads += 1;
        return Promise.resolve({ rows: state.row ? [state.row] : [] });
      },
    },
  } as unknown as DatabaseConnection;
  return { verifier: new ShopifyHookVerifier(database, secrets), state };
}

/** A connection row sealed with `clientSecret`, stamped `updatedAt`. */
function rowOf(secrets: ConnectionSecrets, clientSecret: string, updatedAt: string) {
  const sealed = secrets.seal(
    { kind: 'client_credentials', clientId: 'fake-client-id', clientSecret },
    CONNECTION,
  );
  return {
    id: CONNECTION,
    status: 'active',
    shop_domain: SHOP,
    credentials_ciphertext: sealed.ciphertext,
    credentials_key_version: sealed.keyVersion,
    credentials_stamp: updatedAt,
  } satisfies ShopifyHookConnectionRow;
}

describe('ShopifyHookVerifier', () => {
  const secrets = new ConnectionSecrets({ CONNECTOR_SECRET_KEY: KEY });

  it('uses a replaced client secret at once (the cache is stamped with credentials_updated_at)', async () => {
    const { verifier, state } = verifierWith(secrets);
    const attempt = { connectionId: CONNECTION, shopDomain: SHOP, rawBody: BODY };
    state.row = rowOf(secrets, 'fake-secret-old', '2026-11-01 10:00:00+00');
    expect(
      await verifier.verify({ ...attempt, signature: sign('fake-secret-old') }, 1_000),
    ).toEqual({ provider: 'shopify', connectionId: CONNECTION });

    // Replaced under the same key version, a second later: the old secret no longer verifies.
    state.row = rowOf(secrets, 'fake-secret-new', '2026-11-01 10:00:01+00');
    expect(await verifier.verify({ ...attempt, signature: sign('fake-secret-old') }, 2_000)).toBe(
      null,
    );
    expect(
      await verifier.verify({ ...attempt, signature: sign('fake-secret-new') }, 3_000),
    ).not.toBeNull();
  });

  it('keeps the cached secret while the stamp is unchanged', async () => {
    const { verifier, state } = verifierWith(secrets);
    const row = rowOf(secrets, 'fake-secret-kept', '2026-11-01 10:00:00+00');
    state.row = row;
    const attempt = {
      connectionId: CONNECTION,
      shopDomain: SHOP,
      rawBody: BODY,
      signature: sign('fake-secret-kept'),
    };
    expect(await verifier.verify(attempt, 1_000)).not.toBeNull();
    // The stored value no longer opens, but the stamp did not move: the cache answers.
    state.row = { ...row, credentials_ciphertext: Buffer.alloc(row.credentials_ciphertext.length) };
    expect(await verifier.verify(attempt, 2_000)).not.toBeNull();
  });

  it('refuses before the body step: a malformed id reads nothing, a wrong shop counts a failure', async () => {
    const { verifier, state } = verifierWith(secrets);
    state.row = rowOf(secrets, 'fake-secret', '2026-11-01 10:00:00+00');

    expect(await verifier.target({ connectionId: '%E0', shopDomain: SHOP })).toBeNull();
    expect(state.reads).toBe(0);
    expect(
      await verifier.target({ connectionId: CONNECTION, shopDomain: 'other.myshopify.com' }),
    ).toBeNull();
    expect([state.reads, state.writes]).toEqual([1, 1]);
    expect(
      await verifier.target({ connectionId: CONNECTION, shopDomain: ` ${SHOP.toUpperCase()} ` }),
    ).not.toBeNull();
    state.row = { ...state.row, status: 'archived' };
    expect(await verifier.target({ connectionId: CONNECTION, shopDomain: SHOP })).toBeNull();
  });
});
