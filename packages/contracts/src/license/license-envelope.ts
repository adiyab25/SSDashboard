import { z } from 'zod';

/**
 * The most bytes a license file or upload may hold (spec 0009, AC-14): 16 KB, the same cap as the
 * `licenses_envelope_size` check. A real license is a few hundred bytes; the cap only stops a
 * huge file from being read or stored.
 */
export const LICENSE_ENVELOPE_MAX_BYTES = 16_384;

/** The bundles a license can grant (spec 0009, AC-14); `core` is never licensed, it is always on. */
export const LicenseBundle = z.enum(['warehouse', 'operations']);
/** One bundle a license can grant. */
export type LicenseBundle = z.infer<typeof LicenseBundle>;

/** Base64url text without padding, as the envelope carries its payload and signature. */
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Base64url text without padding');

/**
 * The id of a verifying key (`license-keys.ts` in the api): lower case letters, digits, `.`, `_`,
 * and `-`, at most 64 characters, so it can never carry a path or a sentence.
 */
export const LicenseKeyId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/**
 * The vendor's id of one license (`SSD-2026-0042`): letters, digits, `.`, `_`, and `-`, at most
 * 64 characters. It is the label of the `license.added` audit entry, so it must fit the audit
 * label shape and never hold a name or a sentence.
 */
export const LICENSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A calendar date in a license answer, `YYYY-MM-DD` (a lapse day may fall after 2100). */
export const LicenseDate = z.iso.date();

/** The first and last day a license term may name (security review M2-4). */
export const LICENSE_TERM_FIRST_DAY = '2000-01-01';
/** The last day a license term may name; with grace and a wind down every derived day still parses. */
export const LICENSE_TERM_LAST_DAY = '2100-12-31';

/**
 * A date a license grants or was issued on: `YYYY-MM-DD` from 2000 to 2100 (security review
 * M2-4). A year such as 9999 would push the lapse past what PostgreSQL's `date` and the instant
 * format can hold, so the vendor's command refuses it and the api reads it as `bad_format`.
 */
export const LicenseTermDate = z.iso
  .date()
  .refine(
    (day) => day >= LICENSE_TERM_FIRST_DAY && day <= LICENSE_TERM_LAST_DAY,
    'A license date lies between 2000-01-01 and 2100-12-31',
  );

/**
 * The signed license file (spec 0009, AC-14): `payload` is base64url of the UTF 8 JSON bytes of a
 * `LicensePayload`, and `signature` is a base64url Ed25519 signature over exactly those bytes,
 * made with the key `keyId` names. Strict: any other field makes the file `bad_format`. Never
 * trust the payload of an envelope before the signature is verified.
 */
export const LicenseEnvelope = z.strictObject({
  keyId: LicenseKeyId,
  payload: Base64Url.max(LICENSE_ENVELOPE_MAX_BYTES),
  // An Ed25519 signature is 64 bytes: 86 base64url characters.
  signature: Base64Url.max(128),
});
/** One license envelope as parsed from a file or an upload. */
export type LicenseEnvelope = z.infer<typeof LicenseEnvelope>;

/**
 * What a license grants (spec 0009, AC-14, amended 2026-11-07 for D18). `format` stays 1.
 * `operationsExpiresOn` is present exactly when `operations` is granted (Operations is always a
 * yearly plan); `warehouseExpiresOn` is allowed only with `warehouse` and absent means the
 * Warehouse grant never expires (pilot and trial licenses carry it). `clientCode` and `tenantId`
 * bind the license to one install. Strict: an unknown field is `bad_format`, never ignored.
 */
export const LicensePayload = z
  .strictObject({
    format: z.literal(1),
    licenseId: z.string().regex(LICENSE_ID_PATTERN),
    clientCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/),
    tenantId: z.uuid(),
    bundles: z.array(LicenseBundle).min(1).max(2),
    operationsExpiresOn: LicenseTermDate.optional(),
    warehouseExpiresOn: LicenseTermDate.optional(),
    issuedOn: LicenseTermDate,
  })
  .superRefine((payload, ctx) => {
    if (new Set(payload.bundles).size !== payload.bundles.length) {
      ctx.addIssue({ code: 'custom', path: ['bundles'], message: 'A bundle is listed twice' });
    }
    const operations = payload.bundles.includes('operations');
    if (operations !== (payload.operationsExpiresOn !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['operationsExpiresOn'],
        message: 'Present exactly when the operations bundle is granted',
      });
    }
    if (payload.warehouseExpiresOn !== undefined && !payload.bundles.includes('warehouse')) {
      ctx.addIssue({
        code: 'custom',
        path: ['warehouseExpiresOn'],
        message: 'Allowed only when the warehouse bundle is granted',
      });
    }
  });
/** One verified license payload. */
export type LicensePayload = z.infer<typeof LicensePayload>;

/**
 * The body of `POST /api/platform/license` (spec 0009, AC-20): the license file's text as the
 * manager picked it. Its size is checked by the api (413 `LICENSE_TOO_LARGE` above
 * `LICENSE_ENVELOPE_MAX_BYTES` bytes); everything else is the verifier's job, so a file that is
 * not a license answers 422 `LICENSE_INVALID` with its outcome, never a schema error.
 */
export const PostLicenseBody = z.strictObject({ envelope: z.string().min(1) });
/** The upload body. */
export type PostLicenseBody = z.infer<typeof PostLicenseBody>;
