import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { api, createLocation, createSku, receive, voidReceipt } from './master-data-api';
import { textFor, type TextDirection } from './support';

/**
 * Seeding and waiting helpers for the Stock page and accessibility suites (spec 0006,
 * Milestone 4). Rows are created through the real api; the one thing no screen or endpoint can
 * do, a negative balance, goes straight into the database as its owner.
 */

/** One receipt with a line per SKU (the api takes up to 200). */
export async function receiveMany(
  request: APIRequestContext,
  locationId: string,
  skuIds: string[],
  quantity = 1,
): Promise<{ id: string; number: string }> {
  const { status, body } = await api(
    request,
    'POST',
    '/stock-receipts',
    {
      locationId,
      lines: skuIds.map((skuId) => ({ skuId, quantity, unitCost: '2.0000' })),
    },
    { 'idempotency-key': randomUUID() },
  );
  expect(status, JSON.stringify(body)).toBe(201);
  return body as never;
}

/** A balance of -`quantity` at a location, as an owner write (no screen can post one yet). */
export async function seedNegativeBalance(skuId: string, locationId: string, quantity: number) {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    await pool.query(`UPDATE locations SET allow_negative = true WHERE id = $1::uuid`, [
      locationId,
    ]);
    await pool.query(
      `INSERT INTO stock_levels (variant_id, location_id, on_hand, avg_unit_cost, total_value)
       VALUES ($1::uuid, $2::uuid, $3, 2, $4)`,
      [skuId, locationId, -quantity, -quantity * 2],
    );
  } finally {
    await pool.end();
  }
}

export interface StockScene {
  tag: string;
  location: { id: string; code: string; name: string };
  /** On hand 10. */
  stocked: { id: string; code: string };
  /** Received 4, then the receipt voided: a balance row at 0. */
  zero: { id: string; code: string };
  /** On hand -3. */
  negative: { id: string; code: string };
}

/** A fresh location with one SKU at 10, one at 0 (after a void), and one at -3. */
export async function seedStockScene(request: APIRequestContext): Promise<StockScene> {
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const name = `Scene ${tag}`;
  const location = await createLocation(request, `SC-${tag}`, { en: name, ar: `مشهد ${tag}` });
  const mk = (kind: string) =>
    createSku(request, `${kind}-${tag}`, { en: `${kind} item ${tag}`, ar: `صنف ${kind} ${tag}` });
  const [stocked, zero, negative] = await Promise.all([mk('STK'), mk('ZER'), mk('NEG')]);
  await receive(request, location.id, stocked.id, 10);
  const doomed = await receive(request, location.id, zero.id, 4);
  await voidReceipt(request, doomed.id);
  await seedNegativeBalance(negative.id, location.id, 3);
  return {
    tag,
    location: { id: location.id, code: location.code, name },
    stocked,
    zero,
    negative,
  };
}

/** The answer to a `GET /api/stock` call matching what the page is expected to ask for. */
export function waitForStock(
  page: Page,
  want: {
    locationId?: string | null;
    skuId?: string | null;
    includeZero?: boolean;
    cursor?: boolean;
  } = {},
) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    if (url.pathname !== '/api/stock') return false;
    const params = url.searchParams;
    if (want.locationId !== undefined && (params.get('locationId') ?? null) !== want.locationId) {
      return false;
    }
    if (want.skuId !== undefined && (params.get('skuId') ?? null) !== want.skuId) return false;
    if (want.includeZero !== undefined && params.has('includeZero') !== want.includeZero) {
      return false;
    }
    if (want.cursor !== undefined && params.has('cursor') !== want.cursor) return false;
    return true;
  });
}

/** Picks a place in the top bar location switcher, by what the option says (or all). */
/** `target` is a location code, or the word `all` for All locations. */
export async function chooseLocation(page: Page, dir: TextDirection, target: string) {
  await page
    .getByRole('button', { name: new RegExp(`^${textFor(dir, 'shell.locations.label')}`) })
    .click();
  if (target === 'all') {
    // The box can still hold the text of the last search.
    await page.getByPlaceholder(textFor(dir, 'shell.locations.search')).fill('');
    await page.getByRole('option', { name: textFor(dir, 'shell.locations.all') }).click();
    return;
  }
  await page.getByPlaceholder(textFor(dir, 'shell.locations.search')).fill(target);
  await page.getByRole('option', { name: new RegExp(target) }).click();
}

/** Opens /stock and chooses a location, returning once that location's rows have arrived. */
export async function openStockAt(
  page: Page,
  dir: TextDirection,
  location: { id: string; code: string },
) {
  const first = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/locations';
  });
  await page.goto('/stock');
  await first;
  await expect(page.getByRole('main')).toBeVisible();
  const answered = waitForStock(page, { locationId: location.id, includeZero: false });
  await chooseLocation(page, dir, location.code);
  await answered;
}

/** Types into the picker's search and waits for the debounced request with that text. */
export async function searchPicker(page: Page, text: string) {
  const answered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/skus' && url.searchParams.get('q') === text.trim();
  });
  await page.keyboard.type(text);
  await answered;
}
