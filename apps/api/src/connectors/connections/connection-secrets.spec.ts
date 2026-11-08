import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConnectionSecrets,
  ConnectorKeyVersionClash,
  ConnectorSecretKeyMissing,
  CredentialsUnreadable,
  MIN_SEALED_BYTES,
  connectorKeyVersion,
  credentialsHint,
  type ConnectionCredentials,
} from './connection-secrets.js';

// Test keys only, generated per run; never a real key.
const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('hex');
const CONNECTION = '00000000-0000-4000-8000-000000000001';
const OTHER_CONNECTION = '00000000-0000-4000-8000-000000000002';
const SENTINEL = 'sentinel-secret-must-never-appear-0000';
const CREDENTIALS: ConnectionCredentials = {
  kind: 'client_credentials',
  clientId: 'fake-client-id-abcd',
  clientSecret: SENTINEL,
};

const secrets = (current?: string, previous?: string) =>
  new ConnectionSecrets({ CONNECTOR_SECRET_KEY: current, CONNECTOR_SECRET_KEY_PREVIOUS: previous });

/** Runs `act` and answers the thrown error, failing when nothing is thrown. */
function thrown(act: () => unknown): Error {
  try {
    act();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

describe('ConnectionSecrets', () => {
  it('opens what it sealed, for both credential kinds', () => {
    const box = secrets(KEY_A);
    const legacy: ConnectionCredentials = {
      kind: 'access_token',
      accessToken: 'fake-token',
      apiSecret: 'fake-api-secret',
    };

    expect(box.open(box.seal(CREDENTIALS, CONNECTION), CONNECTION)).toEqual(CREDENTIALS);
    expect(box.open(box.seal(legacy, CONNECTION), CONNECTION)).toEqual(legacy);
  });

  it('seals to at least 29 bytes, with the current key version and a fresh IV each time', () => {
    const box = secrets(KEY_A);
    const one = box.seal(CREDENTIALS, CONNECTION);
    const two = box.seal(CREDENTIALS, CONNECTION);

    expect(MIN_SEALED_BYTES).toBe(29);
    expect(one.ciphertext.length).toBeGreaterThanOrEqual(29);
    expect(one.keyVersion).toBe(box.currentKeyVersion);
    expect(one.keyVersion).toBeGreaterThanOrEqual(1);
    expect(one.keyVersion).toBeLessThanOrEqual(32_767);
    expect(one.ciphertext.equals(two.ciphertext)).toBe(false);
    expect(one.ciphertext.toString('latin1')).not.toContain(SENTINEL);
  });

  it('derives a stable version from the key, the same for its base64 and hex spellings', () => {
    const raw = randomBytes(32);
    const hexBox = secrets(raw.toString('hex'));
    const base64Box = secrets(raw.toString('base64url'));

    expect(hexBox.currentKeyVersion).toBe(connectorKeyVersion(raw));
    expect(base64Box.currentKeyVersion).toBe(hexBox.currentKeyVersion);
  });

  it('refuses a value under a wrong key, with no detail', () => {
    const sealed = secrets(KEY_A).seal(CREDENTIALS, CONNECTION);
    // Same stored version, another key: the tag cannot verify.
    const error = thrown(() =>
      secrets(KEY_B).open({ ...sealed, keyVersion: secrets(KEY_B).currentKeyVersion }, CONNECTION),
    );

    expect(error).toBeInstanceOf(CredentialsUnreadable);
    expect(error.message).toBe('CREDENTIALS_UNREADABLE');
  });

  it('refuses a value whose version no configured key has', () => {
    const sealed = secrets(KEY_A).seal(CREDENTIALS, CONNECTION);

    expect(() => secrets(KEY_B).open(sealed, CONNECTION)).toThrow(CredentialsUnreadable);
  });

  it.each([
    ['the first byte', 0],
    ['an IV byte', 5],
    ['a ciphertext byte', 20],
    ['the last tag byte', -1],
  ])('refuses a value with %s changed', (_what, index) => {
    const box = secrets(KEY_A);
    const sealed = box.seal(CREDENTIALS, CONNECTION);
    const bytes = Buffer.from(sealed.ciphertext);
    const at = index < 0 ? bytes.length + index : index;
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;

    expect(() => box.open({ ...sealed, ciphertext: bytes }, CONNECTION)).toThrow(
      CredentialsUnreadable,
    );
  });

  it('refuses a truncated value, a changed stored version, and another connection id', () => {
    const box = secrets(KEY_A, KEY_B);
    const sealed = box.seal(CREDENTIALS, CONNECTION);
    const previousVersion = secrets(KEY_B).currentKeyVersion;

    expect(() =>
      box.open({ ...sealed, ciphertext: sealed.ciphertext.subarray(0, 28) }, CONNECTION),
    ).toThrow(CredentialsUnreadable);
    expect(() => box.open({ ...sealed, keyVersion: previousVersion }, CONNECTION)).toThrow(
      CredentialsUnreadable,
    );
    expect(() => box.open(sealed, OTHER_CONNECTION)).toThrow(CredentialsUnreadable);
  });

  it('opens a value sealed under the previous key during a rotation', () => {
    const old = secrets(KEY_B).seal(CREDENTIALS, CONNECTION);
    const rotating = secrets(KEY_A, KEY_B);

    expect(rotating.needsReencrypt(old)).toBe(true);
    expect(rotating.open(old, CONNECTION)).toEqual(CREDENTIALS);
  });

  it('re-encrypts a previous key value under the current key, and does nothing the second time', () => {
    const old = secrets(KEY_B).seal(CREDENTIALS, CONNECTION);
    const rotating = secrets(KEY_A, KEY_B);

    const moved = rotating.reencrypt(old, CONNECTION);

    expect(moved?.keyVersion).toBe(rotating.currentKeyVersion);
    expect(moved && rotating.needsReencrypt(moved)).toBe(false);
    expect(moved && rotating.reencrypt(moved, CONNECTION)).toBeNull();
    // After the rotation ends (previous key removed) the moved value still opens.
    expect(moved && secrets(KEY_A).open(moved, CONNECTION)).toEqual(CREDENTIALS);
  });

  it('throws ConnectorSecretKeyMissing when no key is configured', () => {
    const box = secrets();

    expect(() => box.seal(CREDENTIALS, CONNECTION)).toThrow(ConnectorSecretKeyMissing);
    expect(() => box.open({ ciphertext: Buffer.alloc(40), keyVersion: 1 }, CONNECTION)).toThrow(
      ConnectorSecretKeyMissing,
    );
  });

  it('refuses a current and a previous key that derive the same version', () => {
    // The same key twice derives the same version; env.ts refuses that pair before this point.
    expect(() => secrets(KEY_A, KEY_A)).toThrow(ConnectorKeyVersionClash);
  });

  it('never puts the secret in an error message, an error property, or a stack', () => {
    const box = secrets(KEY_A);
    const sealed = box.seal(CREDENTIALS, CONNECTION);
    const errors = [
      thrown(() => box.open(sealed, OTHER_CONNECTION)),
      thrown(() =>
        box.seal({ kind: 'client_credentials', clientId: '', clientSecret: SENTINEL }, CONNECTION),
      ),
    ];

    for (const error of errors) {
      const everything = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`;
      expect(everything).not.toContain(SENTINEL);
    }
  });

  it('hints the last 4 characters of a client id, and nothing of a legacy token', () => {
    expect(credentialsHint(CREDENTIALS)).toBe('abcd');
    expect(
      credentialsHint({ kind: 'access_token', accessToken: 'fake-token', apiSecret: 'fake' }),
    ).toBeNull();
  });
});
