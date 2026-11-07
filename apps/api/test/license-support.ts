import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Test } from '@nestjs/testing';
import type { LicensePayload } from '@ssdashboard/contracts';
import {
  LICENSE_KEY_SET,
  LICENSE_KEYS,
  type LicenseVerifyingKey,
} from '../src/platform/license/license-keys.js';
import { signLicense } from '../src/platform/license/license-signing.js';
import { LicenseService } from '../src/platform/license/license.service.js';
import type { InProcessApi, PlantedPerson } from './in-process-api.js';

/**
 * A vendor key made for one suite: its private half signs, its public half (`entry`, not dev
 * only) is trusted by an api built with `trustTestKey`. The in process api runs with
 * `NODE_ENV=production`, which refuses the committed dev key, so suites that need a license sign
 * with this one.
 */
export interface TestVendorKey {
  readonly privateKey: KeyObject;
  readonly entry: LicenseVerifyingKey;
}

/** A fresh Ed25519 vendor key under `keyId`. */
export function testVendorKey(keyId = 'test-1'): TestVendorKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x as string;
  return { privateKey, entry: { keyId, publicKey: x, devOnly: false } };
}

/** Makes the api under construction trust `key` beside the keys built into the image. */
export function trustTestKey(
  builder: ReturnType<typeof Test.createTestingModule>,
  key: TestVendorKey,
): void {
  builder.overrideProvider(LICENSE_KEY_SET).useValue([...LICENSE_KEYS, key.entry]);
}

/** The install row a license must name. */
export async function installOf(
  api: InProcessApi,
): Promise<{ tenantId: string; clientCode: string }> {
  const { rows } = await api.owner.pool.query<{ id: string; client_code: string }>(
    'SELECT id::text AS id, client_code FROM install',
  );
  return { tenantId: rows[0]?.id as string, clientCode: rows[0]?.client_code as string };
}

/**
 * Records a license signed with `key` for this install through `LicenseService.upload`, as the
 * manager `by`: Operations until 2099-11-07 by default, so the real clock keeps it active (Operations settings are refused
 * on a core only install, security finding S6). Returns the license file's text.
 */
export async function grantLicense(
  api: InProcessApi,
  key: TestVendorKey,
  by: PlantedPerson,
  over: Partial<LicensePayload> = {},
): Promise<string> {
  const install = await installOf(api);
  const text = signLicense(
    {
      format: 1,
      licenseId: 'SSD-TEST-0001',
      clientCode: install.clientCode,
      tenantId: install.tenantId,
      bundles: ['operations'],
      operationsExpiresOn: '2099-11-07',
      issuedOn: '2026-11-07',
      ...over,
    },
    key.entry.keyId,
    key.privateKey,
  );
  await api.app.get(LicenseService).upload(text, { userId: by.id, hat: 'manager' });
  return text;
}
