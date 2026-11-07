import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LicensePayload } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { LICENSE_KEYS, type LicenseVerifyingKey } from './license-keys.js';
import { signLicense } from './license-signing.js';
import {
  devKeysTrusted,
  sha256Hex,
  verifyLicense,
  type LicenseVerifyContext,
} from './license-verifier.js';

// Spec 0009, AC-14 and AC-16: the verifier's outcomes, with the committed dev key and a key made
// here. Nothing here opens a file but the committed dev key, and nothing opens a connection.

const DEV_PRIVATE_KEY = readFileSync(new URL('./dev-license-key.pem', import.meta.url), 'utf8');
const INSTALL = { id: '01937f3a-0000-7000-8000-0000000000aa', clientCode: 'dev' };
const PAYLOAD: LicensePayload = {
  format: 1,
  licenseId: 'SSD-DEV-0001',
  clientCode: INSTALL.clientCode,
  tenantId: INSTALL.id,
  bundles: ['warehouse', 'operations'],
  operationsExpiresOn: '2027-11-07',
  issuedOn: '2026-11-07',
};
const devContext = (trustDevKeys = true): LicenseVerifyContext => ({
  keys: LICENSE_KEYS,
  trustDevKeys,
  install: INSTALL,
});
const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');
const devLicense = (payload: LicensePayload = PAYLOAD): string =>
  signLicense(payload, 'dev-1', DEV_PRIVATE_KEY);
const outcomeOf = (text: string, context = devContext()) => {
  const result = verifyLicense(bytes(text), context);
  return result.verified ? 'verified' : result.outcome;
};

describe('verifyLicense (AC-14)', () => {
  it('verifies a license signed with the committed dev key outside production', () => {
    const text = devLicense();
    const result = verifyLicense(bytes(text), devContext());

    expect(result).toEqual({
      verified: true,
      sha256: sha256Hex(bytes(text)),
      keyId: 'dev-1',
      envelope: text,
      payloadSha256: sha256Hex(
        Buffer.from((JSON.parse(text) as { payload: string }).payload, 'base64url'),
      ),
      payload: PAYLOAD,
    });
  });

  it('ships only the dev key, marked devOnly (owner ruling 1)', () => {
    expect(LICENSE_KEYS).toEqual([expect.objectContaining({ keyId: 'dev-1', devOnly: true })]);
  });

  it('refuses the dev key where dev keys are not trusted, whatever the signature', () => {
    expect(outcomeOf(devLicense(), devContext(false))).toBe('dev_key_in_production');
  });

  // Security review M2-1: dev keys count only in a development build outside production.
  it.each([
    ['production with the dev version', 'production', '0.0.0-dev', false],
    ['production with a release version', 'production', '1.2.0', false],
    ['test with a release version', 'test', '1.2.0', false],
    ['development with a release version', 'development', '2026.11.7', false],
    ['test with the dev version', 'test', '0.0.0-dev', true],
    ['development with the dev version', 'development', '0.0.0-dev', true],
  ] as const)('trusts dev keys in %s: %s', (_label, nodeEnv, version, trusted) => {
    expect(devKeysTrusted({ NODE_ENV: nodeEnv, APP_VERSION: version })).toBe(trusted);
    expect(outcomeOf(devLicense(), devContext(trusted))).toBe(
      trusted ? 'verified' : 'dev_key_in_production',
    );
  });

  it('keys the payload hash by the signed bytes, not the envelope layout', () => {
    const text = devLicense();
    const compact = JSON.stringify(JSON.parse(text));
    const first = verifyLicense(bytes(text), devContext());
    const second = verifyLicense(bytes(compact), devContext());

    expect(first.sha256).not.toBe(second.sha256);
    expect(first).toMatchObject({ verified: true });
    expect(second).toMatchObject({
      verified: true,
      payloadSha256: (first as { payloadSha256: string }).payloadSha256,
    });
  });

  it('refuses one flipped byte of the payload or the signature as bad_signature', () => {
    const envelope = JSON.parse(devLicense()) as {
      keyId: string;
      payload: string;
      signature: string;
    };
    const payload = Buffer.from(envelope.payload, 'base64url');
    payload[10] = (payload[10] ?? 0) ^ 0x01;
    const tamperedPayload = { ...envelope, payload: payload.toString('base64url') };
    const signature = Buffer.from(envelope.signature, 'base64url');
    signature[0] = (signature[0] ?? 0) ^ 0x01;
    const tamperedSignature = { ...envelope, signature: signature.toString('base64url') };

    expect(outcomeOf(JSON.stringify(tamperedPayload))).toBe('bad_signature');
    expect(outcomeOf(JSON.stringify(tamperedSignature))).toBe('bad_signature');
    expect(outcomeOf(JSON.stringify({ ...envelope, signature: 'AAAA' }))).toBe('bad_signature');
  });

  it('refuses a key the image does not hold as unknown_key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(outcomeOf(signLicense(PAYLOAD, 'vendor-9', privateKey))).toBe('unknown_key');
  });

  it('refuses a known key id signed by another private key as bad_signature', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(outcomeOf(signLicense(PAYLOAD, 'dev-1', privateKey))).toBe('bad_signature');
  });

  it('refuses a license for another install as wrong_install', () => {
    expect(outcomeOf(devLicense({ ...PAYLOAD, clientCode: 'other' }))).toBe('wrong_install');
    expect(
      outcomeOf(devLicense({ ...PAYLOAD, tenantId: '01937f3a-0000-7000-8000-0000000000bb' })),
    ).toBe('wrong_install');
  });

  it('refuses what is not a license as bad_format', () => {
    expect(outcomeOf('not json')).toBe('bad_format');
    expect(outcomeOf('{}')).toBe('bad_format');
    expect(outcomeOf(JSON.stringify({ ...JSON.parse(devLicense()), extra: 1 }))).toBe('bad_format');
    expect(outcomeOf(' '.repeat(16_385))).toBe('bad_format');
    expect(verifyLicense(Buffer.from([0xff, 0xfe, 0x7b]), devContext())).toMatchObject({
      outcome: 'bad_format',
    });
  });

  it('refuses a signed payload that breaks the payload rules as bad_format', () => {
    // A key made here, so the signature verifies and only the payload is wrong.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const x = publicKey.export({ format: 'jwk' }).x as string;
    const keys: LicenseVerifyingKey[] = [{ keyId: 'test-1', publicKey: x, devOnly: false }];
    const body = Buffer.from(JSON.stringify({ ...PAYLOAD, format: 2 }), 'utf8');
    const text = JSON.stringify({
      keyId: 'test-1',
      payload: body.toString('base64url'),
      signature: sign(null, body, privateKey).toString('base64url'),
    });

    expect(outcomeOf(text, { keys, trustDevKeys: false, install: INSTALL })).toBe('bad_format');
    expect(
      outcomeOf(signLicense(PAYLOAD, 'test-1', privateKey), {
        keys,
        trustDevKeys: false,
        install: INSTALL,
      }),
    ).toBe('verified');
  });
});

describe('signLicense', () => {
  it('refuses to sign a payload the api would refuse', () => {
    expect(() => devLicense({ ...PAYLOAD, bundles: ['warehouse'] })).toThrow();
  });

  it('signs a pilot Warehouse license with its expiry', () => {
    const pilot = { ...PAYLOAD, bundles: ['warehouse' as const], warehouseExpiresOn: '2027-02-07' };
    const { operationsExpiresOn: _, ...payload } = pilot;
    const result = verifyLicense(bytes(devLicense(payload)), devContext());
    expect(result).toMatchObject({ verified: true, payload: { warehouseExpiresOn: '2027-02-07' } });
  });
});
