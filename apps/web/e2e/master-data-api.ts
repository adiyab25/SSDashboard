import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';

/**
 * Seeding helpers for the master data suite (spec 0006, Milestone 3). They drive the real api
 * with the session cookie of the request context they are given, so a test can set up a SKU, a
 * location, or stock in milliseconds and spend its time on the screen under test.
 */
export async function api(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // A write needs the app's own Origin (the api's origin check), as the browser sends it.
  const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost:3000').origin;
  const response = await request.fetch(`/api${path}`, {
    method,
    data,
    headers: { origin, ...headers },
  });
  const text = await response.text();
  return { status: response.status(), body: (text ? JSON.parse(text) : {}) as never };
}

export interface SeededSku {
  id: string;
  code: string;
  updatedAt: string;
}

export interface SeededLocation {
  id: string;
  code: string;
  updatedAt: string;
}

export async function createSku(
  request: APIRequestContext,
  code: string,
  name: { en?: string; ar?: string } = { en: `Item ${code}` },
  price?: string,
): Promise<SeededSku> {
  const { status, body } = await api(request, 'POST', '/products', {
    name,
    variants: [{ sku: code, ...(price ? { price } : {}) }],
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return body as never;
}

export async function createLocation(
  request: APIRequestContext,
  code: string,
  name: { en?: string; ar?: string } = { en: `Place ${code}` },
  kind: 'warehouse' | 'shop' = 'warehouse',
): Promise<SeededLocation> {
  const { status, body } = await api(request, 'POST', '/locations', { code, name, kind });
  expect(status, JSON.stringify(body)).toBe(201);
  return body as never;
}

export async function receive(
  request: APIRequestContext,
  locationId: string,
  skuId: string,
  quantity: number,
  unitCost = '5.0000',
): Promise<{ id: string; number: string }> {
  const { status, body } = await api(
    request,
    'POST',
    '/stock-receipts',
    { locationId, lines: [{ skuId, quantity, unitCost }] },
    { 'idempotency-key': randomUUID() },
  );
  expect(status, JSON.stringify(body)).toBe(201);
  return body as never;
}

export async function voidReceipt(request: APIRequestContext, id: string, reason = 'QA void') {
  const { status, body } = await api(request, 'POST', `/stock-receipts/${id}/void`, { reason });
  expect(status, JSON.stringify(body)).toBe(200);
}

/**
 * Writes one opening balance movement with no person behind it (a system job), straight into
 * the dev database as its owner: no screen or endpoint can post one yet.
 */
export async function postSystemMovement(skuId: string, locationId: string, quantity: number) {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at)
       VALUES ($1, 'qa', 'opening_balance', $2::uuid, now()) RETURNING id`,
      [`qa-system-${randomUUID()}`, randomUUID()],
    );
    await pool.query(
      `INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost, total_cost, effective_at, recorded_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 2, $4 * 2, now(), now())`,
      [rows[0]?.id, skuId, locationId, quantity],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Clicks Load more until the row is on screen (a shared database keeps rows between runs).
 * `loadMore` is the button's text in the page language.
 */
export async function findRow(
  page: Page,
  table: string,
  text: string | RegExp,
  loadMore = 'Load more',
): Promise<Locator> {
  const grid = page.getByRole('table', { name: table });
  const row = grid.getByRole('row', { name: text });
  const more = page.getByRole('button', { name: loadMore });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // Wait for the list to finish loading before judging what is on it.
    await expect(grid).not.toHaveAttribute('aria-busy', 'true');
    if (await row.count()) break;
    if (!(await more.isVisible())) break;
    await more.click();
    await page.waitForTimeout(200);
  }
  return row;
}
