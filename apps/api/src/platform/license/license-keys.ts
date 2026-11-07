/**
 * One public key the image trusts to sign licenses (spec 0009, AC-14). `publicKey` is the raw
 * 32 byte Ed25519 public key in base64url (the `x` of its JWK). A `devOnly` key is refused unless
 * `NODE_ENV` is not `production` and `APP_VERSION` is `0.0.0-dev` (`devKeysTrusted`, outcome
 * `dev_key_in_production`), so a release build never trusts it.
 */
export interface LicenseVerifyingKey {
  readonly keyId: string;
  readonly publicKey: string;
  readonly devOnly: boolean;
}

/**
 * The Nest token of the verifying keys `LicenseVerifier` trusts. Bound to `LICENSE_KEYS` in
 * `PlatformModule`; tests may bind their own keys, never production code.
 */
export const LICENSE_KEY_SET = Symbol('LICENSE_KEY_SET');

/**
 * Every key built into the image (spec 0009, owner ruling 1 of 2026-11-07). This release ships
 * only the committed development key, `devOnly`: its private half is committed beside this file
 * (`dev-license-key.pem`) for `pnpm bootstrap` and the tests, which is safe only because a
 * release build (any `APP_VERSION` but `0.0.0-dev`) or a production process refuses every
 * license it signs. The owner adds the production primary and
 * standby public keys in a later release; until then a production image refuses every license.
 * Only public keys ever go here: never a production private key, in this file or anywhere in the
 * repository or the image. Verification reads nothing else and never opens a network connection.
 */
export const LICENSE_KEYS: readonly LicenseVerifyingKey[] = [
  { keyId: 'dev-1', publicKey: '5bg_KsrgLDbJ9fTp0aWxvHmrCno_AIcuXzKWlxZzIr8', devOnly: true },
];
