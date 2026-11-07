// The vendor's signing command (spec 0009, AC-14). Run from a checkout, never inside an install:
//
//   node apps/api/dist/platform/license/sign-license.js --private-key <path.pem> --key-id <id> \
//     --license-id <id> --client-code <code> --tenant-id <uuid> --bundles warehouse,operations \
//     --operations-expires-on 2027-11-07 [--warehouse-expires-on 2027-02-07] [--issued-on <date>] \
//     [--out <file>]
//
// It reads the private key from the given path only and prints the envelope (or writes it to
// --out). Without a private key it signs nothing, so the copy in the image is harmless. The
// committed `dev-license-key.pem` signs development licenses only (key `dev-1`, trusted only when
// NODE_ENV is not production and APP_VERSION is 0.0.0-dev); a production private key stays offline with the owner and never enters
// the repository, an image, or an install.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LicenseBundle, type LicensePayload } from '@ssdashboard/contracts';
import { signLicense } from './license-signing.js';

const { values } = parseArgs({
  options: {
    'private-key': { type: 'string' },
    'key-id': { type: 'string' },
    'license-id': { type: 'string' },
    'client-code': { type: 'string' },
    'tenant-id': { type: 'string' },
    bundles: { type: 'string' },
    'operations-expires-on': { type: 'string' },
    'warehouse-expires-on': { type: 'string' },
    'issued-on': { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
});

const required = ['private-key', 'key-id', 'license-id', 'client-code', 'tenant-id', 'bundles'];
const missing = required.filter((name) => values[name as keyof typeof values] === undefined);
if (missing.length > 0) {
  console.error(`sign-license: missing ${missing.map((name) => `--${name}`).join(', ')}`);
  process.exit(2);
}

try {
  const payload: LicensePayload = {
    format: 1,
    licenseId: values['license-id'] as string,
    clientCode: values['client-code'] as string,
    tenantId: values['tenant-id'] as string,
    bundles: (values.bundles as string)
      .split(',')
      .map((bundle) => LicenseBundle.parse(bundle.trim())),
    ...(values['operations-expires-on'] !== undefined && {
      operationsExpiresOn: values['operations-expires-on'],
    }),
    ...(values['warehouse-expires-on'] !== undefined && {
      warehouseExpiresOn: values['warehouse-expires-on'],
    }),
    issuedOn: values['issued-on'] ?? new Date().toISOString().slice(0, 10),
  };
  const envelope = signLicense(
    payload,
    values['key-id'] as string,
    readFileSync(values['private-key'] as string, 'utf8'),
  );
  if (values.out === undefined) process.stdout.write(envelope);
  else writeFileSync(values.out, envelope, { mode: 0o644 });
} catch (error) {
  // The message names the field that is wrong, never the key's content.
  console.error(`sign-license: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
