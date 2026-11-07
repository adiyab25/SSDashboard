import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { LicenseEnvelope, LicensePayload } from '@ssdashboard/contracts';

/**
 * Signs a license (spec 0009, AC-14): checks the payload against the strict `LicensePayload`
 * schema (a ZodError for a bad one, so the vendor never issues a license the api refuses), encodes
 * its JSON as UTF 8 bytes, signs exactly those bytes with Ed25519, and returns the envelope as
 * the JSON text of the license file. `privateKey` is a PEM text or a KeyObject. Used by the
 * vendor's `sign-license` command, `pnpm bootstrap` (through that command), and tests; the api
 * and the worker never sign. Never log the key or keep it anywhere.
 */
export function signLicense(
  payload: LicensePayload,
  keyId: string,
  privateKey: string | KeyObject,
): string {
  const checked = LicensePayload.parse(payload);
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const bytes = Buffer.from(JSON.stringify(checked), 'utf8');
  const envelope = LicenseEnvelope.parse({
    keyId,
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, key).toString('base64url'),
  });
  return `${JSON.stringify(envelope, null, 2)}\n`;
}
