import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ENV } from '../../config/config.module.js';
import { connectorKeyBytes, type Env } from '../../config/env.js';

/**
 * A connection's credentials as the owner typed them (spec 0015, AC-2, Q-13.1, Q-13.8):
 * `client_credentials` for a Dev Dashboard app (client id and secret, exchanged for a token by the
 * Shopify client), or `access_token` for a legacy custom app made in the Shopify admin before 2026
 * (its Admin API access token, and its API secret, which signs that app's webhooks).
 *
 * Lives only in memory: never log it, put it in an error, an answer, an audit entry, an event, or a
 * row other than `connections.credentials_ciphertext` (sealed by `ConnectionSecrets.seal`).
 */
export type ConnectionCredentials =
  | {
      readonly kind: 'client_credentials';
      readonly clientId: string;
      readonly clientSecret: string;
    }
  | { readonly kind: 'access_token'; readonly accessToken: string; readonly apiSecret: string };

/** The shape `open` accepts after decryption; anything else is `CredentialsUnreadable`. */
const CredentialsSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('client_credentials'),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('access_token'),
    accessToken: z.string().min(1),
    apiSecret: z.string().min(1),
  }),
]);

/**
 * What `connections` stores (spec 0015 data model): `credentials_ciphertext` and
 * `credentials_key_version`, always written together.
 */
export interface SealedCredentials {
  /** Format byte, 12 byte IV, ciphertext, 16 byte GCM tag: at least 29 bytes. */
  readonly ciphertext: Buffer;
  /** The version of the key that sealed it (`connectorKeyVersion`), 1 to 32767. */
  readonly keyVersion: number;
}

/** The first byte of every sealed value: the layout below. A new layout takes a new byte. */
const FORMAT_V1 = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The shortest sealed value: format byte, IV, and tag around an empty plaintext. */
export const MIN_SEALED_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** Base class of every connection secrets error. Its message is a code, never a value. */
export class ConnectionSecretsError extends Error {
  /** @param code - the stable code, also the message. */
  constructor(readonly code: string) {
    super(code);
    this.name = new.target.name;
  }
}

/** Sealing or opening was asked for while `CONNECTOR_SECRET_KEY` is unset (development or test). */
export class ConnectorSecretKeyMissing extends ConnectionSecretsError {
  /** Takes no argument: the code says it all. */
  constructor() {
    super('CONNECTOR_SECRET_KEY_MISSING');
  }
}

/**
 * The sealed value cannot be opened: no configured key has its version, the GCM tag does not
 * verify (a wrong key, a changed byte, or another connection's value), or the plaintext is not a
 * credentials object. The caller sets the connection's health to `CREDENTIALS_UNREADABLE` and asks
 * the owner to type the keys again.
 */
export class CredentialsUnreadable extends ConnectionSecretsError {
  /** Takes no argument: the cause is never given, so nothing about the value leaks. */
  constructor() {
    super('CREDENTIALS_UNREADABLE');
  }
}

/** The current and the previous key derive the same version (1 in 32767); generate another key. */
export class ConnectorKeyVersionClash extends ConnectionSecretsError {
  /** Takes no argument. */
  constructor() {
    super('CONNECTOR_KEY_VERSION_CLASH');
  }
}

/**
 * The key version scheme: a key's version is derived from the key itself, so a rotation needs no
 * version variable kept in step by hand. It is the first two bytes of
 * HMAC-SHA256(key, "ssdashboard connector key version") read as an unsigned number, reduced to
 * 1..32767 (`credentials_key_version` is a positive `smallint`). The HMAC reveals nothing about the
 * key. Two keys may derive the same version (1 in 32767): `ConnectionSecrets` refuses to start with
 * a current and a previous key that clash. The version is also bound into the GCM additional data,
 * so a value whose stored version was changed does not open.
 */
export function connectorKeyVersion(key: Buffer): number {
  const digest = createHmac('sha256', key).update('ssdashboard connector key version').digest();
  return (digest.readUInt16BE(0) % 32_767) + 1;
}

/** The GCM additional data: binds a value to its key version and its connection. */
function additionalData(keyVersion: number, connectionId: string): Buffer {
  return Buffer.from(`ssdashboard:connection-credentials:v1:${keyVersion}:${connectionId}`, 'utf8');
}

/** A configured key and its derived version. */
interface VersionedKey {
  readonly key: Buffer;
  readonly version: number;
}

/**
 * AES-256-GCM seal and open of connection credentials (spec 0015, AC-2), the only place a stored
 * secret becomes readable. Keys come from `CONNECTOR_SECRET_KEY` (current) and
 * `CONNECTOR_SECRET_KEY_PREVIOUS` (during a rotation); versions follow `connectorKeyVersion`.
 *
 * Each value is bound to its connection id, so a value copied to another connection row does not
 * open: generate the connection id before sealing. Must never log, return, or put in an error a
 * key, a plaintext, or a decryption detail.
 */
@Injectable()
export class ConnectionSecrets {
  private readonly current: VersionedKey | undefined;
  private readonly previous: VersionedKey | undefined;

  /** @param env - the validated env; only the two connector key variables are read. */
  constructor(
    @Inject(ENV) env: Pick<Env, 'CONNECTOR_SECRET_KEY' | 'CONNECTOR_SECRET_KEY_PREVIOUS'>,
  ) {
    this.current = versioned(env.CONNECTOR_SECRET_KEY);
    this.previous = versioned(env.CONNECTOR_SECRET_KEY_PREVIOUS);
    if (this.current && this.previous && this.current.version === this.previous.version) {
      throw new ConnectorKeyVersionClash();
    }
  }

  /** The version `seal` writes now. Throws `ConnectorSecretKeyMissing` without a current key. */
  get currentKeyVersion(): number {
    return this.requireCurrent().version;
  }

  /**
   * Seals credentials under the current key for one connection, with a fresh random IV. The
   * caller stores both fields of the answer in the same write.
   */
  seal(credentials: ConnectionCredentials, connectionId: string): SealedCredentials {
    const { key, version } = this.requireCurrent();
    const valid = CredentialsSchema.safeParse(credentials);
    // The zod error is dropped on purpose: never let an issue path or message carry a value.
    if (!valid.success) throw new ConnectionSecretsError('CREDENTIALS_INVALID');
    const plaintext = Buffer.from(JSON.stringify(valid.data), 'utf8');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalData(version, connectionId));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    return {
      ciphertext: Buffer.concat([Buffer.from([FORMAT_V1]), iv, body, cipher.getAuthTag()]),
      keyVersion: version,
    };
  }

  /**
   * Opens a sealed value of one connection with the key of its version (current or previous).
   * Throws `CredentialsUnreadable` for every failure, with no detail, and
   * `ConnectorSecretKeyMissing` when no key is configured at all.
   */
  open(sealed: SealedCredentials, connectionId: string): ConnectionCredentials {
    if (!this.current && !this.previous) throw new ConnectorSecretKeyMissing();
    const key = [this.current, this.previous].find((k) => k?.version === sealed.keyVersion)?.key;
    const bytes = sealed.ciphertext;
    if (!key || bytes.length < MIN_SEALED_BYTES || bytes[0] !== FORMAT_V1) {
      throw new CredentialsUnreadable();
    }
    let plaintext: Buffer;
    try {
      const iv = bytes.subarray(1, 1 + IV_BYTES);
      const tag = bytes.subarray(bytes.length - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(additionalData(sealed.keyVersion, connectionId));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(bytes.subarray(1 + IV_BYTES, bytes.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new CredentialsUnreadable();
    }
    try {
      const parsed = CredentialsSchema.safeParse(JSON.parse(plaintext.toString('utf8')) as unknown);
      if (!parsed.success) throw new CredentialsUnreadable();
      return parsed.data;
    } catch {
      throw new CredentialsUnreadable();
    } finally {
      plaintext.fill(0);
    }
  }

  /** True when the value was sealed under another key than the current one. */
  needsReencrypt(sealed: SealedCredentials): boolean {
    return sealed.keyVersion !== this.requireCurrent().version;
  }

  /**
   * The re-encrypt step of a key rotation (spec 0015, *Configuration required*): opens a value
   * sealed under the previous key and seals it again under the current one. Answers null when the
   * value is already under the current key, so a rerun is a no op. Pure apart from the fresh IV;
   * the job that walks every connection and writes the answer is spec 0015 task 12's.
   */
  reencrypt(sealed: SealedCredentials, connectionId: string): SealedCredentials | null {
    if (!this.needsReencrypt(sealed)) return null;
    return this.seal(this.open(sealed, connectionId), connectionId);
  }

  private requireCurrent(): VersionedKey {
    if (!this.current) throw new ConnectorSecretKeyMissing();
    return this.current;
  }
}

/**
 * The hint the connection screen shows (AC-2): the last 4 characters of the client id, or null
 * for a legacy access token (no part of a token or a secret is ever shown).
 */
export function credentialsHint(credentials: ConnectionCredentials): string | null {
  return credentials.kind === 'client_credentials' ? credentials.clientId.slice(-4) : null;
}

/** A key from the env with its version, or undefined when unset. */
function versioned(text: string | undefined): VersionedKey | undefined {
  if (text === undefined) return undefined;
  const key = connectorKeyBytes(text);
  // env.ts validated the text, so this is only reached by a caller that skipped it.
  if (!key) throw new ConnectionSecretsError('CONNECTOR_SECRET_KEY_INVALID');
  return { key, version: connectorKeyVersion(key) };
}
