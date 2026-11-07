import { readFileSync } from 'node:fs';
import { createDatabase } from '@ssdashboard/db';
import { signLicense } from '../../api/src/platform/license/license-signing.js';
import { ownerDatabaseUrl } from './auth';

/** The committed development key: it verifies only while the api runs without NODE_ENV=production. */
const DEV_KEY = new URL('../../api/src/platform/license/dev-license-key.pem', import.meta.url);

/**
 * The text of a license file for the e2e install, signed with the committed development key and
 * bound to the install row (`install.id` and `install.client_code`). It grants Warehouse with no
 * expiry under the fixed id `E2E-NOOP-0001`.
 *
 * Why this one: an upload is append only and permanent in the e2e database, and a recorded
 * license can never be removed. Warehouse for ever shrinks nothing. Where the dev bootstrap
 * license is recorded it already grants Warehouse, so this one adds nothing (`changed: false`).
 * On a fresh database (CI) the first upload licenses Warehouse for good, so a later test that
 * needs Warehouse unlicensed must route mock its list. The fixed id means a rerun adds no
 * `licenses` row (the check rows it records are not licenses).
 */
export async function signedWarehouseLicense(): Promise<string> {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const { rows } = await pool.query<{ id: string; client_code: string }>(
      'SELECT id, client_code FROM install',
    );
    const install = rows[0];
    if (!install) throw new Error('The install row is missing; run the migrations.');
    return signLicense(
      {
        format: 1,
        licenseId: 'E2E-NOOP-0001',
        clientCode: install.client_code,
        tenantId: install.id,
        bundles: ['warehouse'],
        issuedOn: '2026-11-07',
      },
      'dev-1',
      readFileSync(DEV_KEY, 'utf8'),
    );
  } finally {
    await pool.end();
  }
}
