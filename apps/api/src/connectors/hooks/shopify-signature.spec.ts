import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyShopifySignature } from './shopify-signature.js';

// Spec 0015 AC-4 and AC-26: known good and tampered bodies, signed in the test with a fake secret.
const SECRET = 'fake-webhook-secret-for-tests-only';
const BODY = Buffer.from(
  JSON.stringify({ id: 5550000001001, admin_graphql_api_id: 'gid://shopify/Order/5550000001001' }),
  'utf8',
);
const sign = (body: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('base64');

describe('verifyShopifySignature (AC-4)', () => {
  it('accepts the base64 HMAC SHA256 of the raw bytes with the secret, as a string or a buffer', () => {
    expect(verifyShopifySignature(BODY, sign(BODY), SECRET)).toBe(true);
    expect(verifyShopifySignature(BODY, sign(BODY), Buffer.from(SECRET, 'utf8'))).toBe(true);
    expect(verifyShopifySignature(BODY, ` ${sign(BODY)} `, SECRET)).toBe(true);
  });

  it('refuses a body with one byte changed', () => {
    const tampered = Buffer.from(BODY);
    tampered[10] = (tampered[10] ?? 0) ^ 1;
    expect(verifyShopifySignature(tampered, sign(BODY), SECRET)).toBe(false);
  });

  it('refuses another secret', () => {
    expect(verifyShopifySignature(BODY, sign(BODY, 'another-secret'), SECRET)).toBe(false);
  });

  it('refuses a signature of the wrong length without comparing', () => {
    const short = Buffer.from(sign(BODY), 'base64').subarray(0, 31).toString('base64');
    const long = Buffer.concat([Buffer.from(sign(BODY), 'base64'), Buffer.from([0])]).toString(
      'base64',
    );
    expect(verifyShopifySignature(BODY, short, SECRET)).toBe(false);
    expect(verifyShopifySignature(BODY, long, SECRET)).toBe(false);
  });

  it('refuses a missing, empty, or non base64 header', () => {
    expect(verifyShopifySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyShopifySignature(BODY, '', SECRET)).toBe(false);
    expect(verifyShopifySignature(BODY, 'not base64 at all!', SECRET)).toBe(false);
    expect(
      verifyShopifySignature(BODY, createHmac('sha256', SECRET).update(BODY).digest('hex'), SECRET),
    ).toBe(false);
  });
});
