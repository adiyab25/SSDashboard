import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  LICENSE_ENVELOPE_MAX_BYTES,
  LicenseEnvelope,
  LicensePayload,
  type LicenseCheckOutcome,
} from '@ssdashboard/contracts';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { LICENSE_KEY_SET, type LicenseVerifyingKey } from './license-keys.js';

/** The install a license must be bound to: the `install` row's id and client code. */
export interface InstallIdentity {
  readonly id: string;
  readonly clientCode: string;
}

/** Why an envelope did not verify (spec 0009, AC-16). */
export type LicenseRefusal = Extract<
  LicenseCheckOutcome,
  'bad_format' | 'bad_signature' | 'unknown_key' | 'dev_key_in_production' | 'wrong_install'
>;

/**
 * What verifying one envelope gave: a verified license with its payload, or the refusal. Both
 * carry the SHA 256 of the bytes checked, the only trace of a file that ever reaches a log.
 */
export type LicenseVerification =
  | {
      readonly verified: true;
      readonly sha256: string;
      readonly keyId: string;
      /** The envelope text exactly as verified, stored in `licenses.envelope`. */
      readonly envelope: string;
      /** The SHA 256 of the signed payload bytes: one license, however its envelope is laid out. */
      readonly payloadSha256: string;
      readonly payload: LicensePayload;
    }
  | { readonly verified: false; readonly sha256: string; readonly outcome: LicenseRefusal };

/** What `verifyLicense` trusts: the keys, whether `devOnly` keys count, and the install. */
export interface LicenseVerifyContext {
  readonly keys: readonly LicenseVerifyingKey[];
  /** From `devKeysTrusted(env)`: false refuses every `devOnly` key (`dev_key_in_production`). */
  readonly trustDevKeys: boolean;
  readonly install: InstallIdentity;
}

/** The `APP_VERSION` of a development build (env default and the Dockerfile's build arg default). */
export const DEV_APP_VERSION = '0.0.0-dev';

/**
 * Whether this process may trust a `devOnly` key (security review M2-1): only when `NODE_ENV` is
 * not `production` AND `APP_VERSION` is the development marker `0.0.0-dev`. Inside the `app`
 * image both are baked in (`deploy/Dockerfile.app` sets `NODE_ENV=production` and `APP_VERSION`
 * from its build arg, and Compose passes `SSD_VERSION`), so a bare `node dist/main.js` in the
 * image refuses the dev key, and a release image keeps refusing it even when someone overrides
 * `NODE_ENV=test`. A build run from a checkout has neither unless its env sets them: there the
 * dev key is trusted, as development needs (security re-review R4). Fails closed: any other
 * version refuses. Pure.
 */
export function devKeysTrusted(env: Pick<Env, 'NODE_ENV' | 'APP_VERSION'>): boolean {
  return env.NODE_ENV !== 'production' && env.APP_VERSION === DEV_APP_VERSION;
}

/** The SHA 256 of some bytes, lower case hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Decodes canonical base64url only: text that does not round trip is refused (null). */
function base64url(text: string): Buffer | null {
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/** Parses JSON, null when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** UTF 8 text of some bytes, null when they are not valid UTF 8. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** The KeyObject of a raw Ed25519 public key in base64url. */
function publicKeyOf(key: LicenseVerifyingKey): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, format: 'jwk' });
}

/**
 * Verifies one license file or upload (spec 0009, AC-14), in this order: at most 16 KB of UTF 8
 * JSON in the strict envelope shape (`bad_format`); a key built into the image (`unknown_key`),
 * never a `devOnly` one unless `devKeysTrusted` (`dev_key_in_production`); an Ed25519 signature over
 * exactly the payload bytes (`bad_signature`, through `node:crypto`); a strict payload
 * (`bad_format`); and the install binding, client code and tenant id (`wrong_install`). Pure
 * apart from the hashing: it reads no file, no clock, and never opens a network connection. It
 * never trusts a payload before its signature verifies.
 */
export function verifyLicense(
  bytes: Uint8Array,
  context: LicenseVerifyContext,
): LicenseVerification {
  const sha256 = sha256Hex(bytes);
  const refuse = (outcome: LicenseRefusal): LicenseVerification => ({
    verified: false,
    sha256,
    outcome,
  });
  if (bytes.byteLength > LICENSE_ENVELOPE_MAX_BYTES) return refuse('bad_format');
  const text = decodeUtf8(bytes);
  if (text === null) return refuse('bad_format');
  const envelope = LicenseEnvelope.safeParse(parseJson(text));
  if (!envelope.success) return refuse('bad_format');

  const key = context.keys.find((candidate) => candidate.keyId === envelope.data.keyId);
  if (!key) return refuse('unknown_key');
  if (key.devOnly && !context.trustDevKeys) return refuse('dev_key_in_production');

  const payloadBytes = base64url(envelope.data.payload);
  const signature = base64url(envelope.data.signature);
  if (!payloadBytes || !signature || signature.byteLength !== 64) return refuse('bad_signature');
  if (!verify(null, payloadBytes, publicKeyOf(key), signature)) return refuse('bad_signature');

  const payloadText = decodeUtf8(payloadBytes);
  const payload = LicensePayload.safeParse(payloadText === null ? null : parseJson(payloadText));
  if (!payload.success) return refuse('bad_format');
  if (
    payload.data.tenantId !== context.install.id ||
    payload.data.clientCode !== context.install.clientCode
  ) {
    return refuse('wrong_install');
  }
  return {
    verified: true,
    sha256,
    keyId: key.keyId,
    envelope: text,
    payloadSha256: sha256Hex(payloadBytes),
    payload: payload.data,
  };
}

/**
 * The Nest face of `verifyLicense`: the keys built into the image (`LICENSE_KEY_SET`) and
 * `devKeysTrusted` of the validated env (`NODE_ENV` and `APP_VERSION`). Holds no state and never
 * logs.
 */
@Injectable()
export class LicenseVerifier {
  /** Takes the trusted keys and the env (`NODE_ENV`, `APP_VERSION`). */
  constructor(
    @Inject(LICENSE_KEY_SET) private readonly keys: readonly LicenseVerifyingKey[],
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Verifies the bytes of one envelope for this install; see `verifyLicense`. */
  verify(bytes: Uint8Array, install: InstallIdentity): LicenseVerification {
    return verifyLicense(bytes, {
      keys: this.keys,
      trustDevKeys: devKeysTrusted(this.env),
      install,
    });
  }
}
