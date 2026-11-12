import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { api } from './master-data-api';

/**
 * Helpers of the specs that move the install's one online location (spec 0011). The flag is shared
 * state of the database, and Playwright runs files, and the desktop and mobile projects, in
 * parallel workers, so `serial` inside one file is not enough: two workers could each move the
 * flag under the other. A directory the specs create (`mkdir` fails when it exists) is the lock
 * across workers; the holder releases it in `afterEach`, after stopping online stock.
 */
const LOCK = join(tmpdir(), 'ssdashboard-e2e-online-flag.lock');
/** A lock older than this belongs to a worker that died; it is taken over. */
const STALE_MS = 3 * 60_000;

/**
 * Waits for the lock, then returns the function that releases it. A test that moves the flag in
 * its own body (an orders test that packs) takes it there and releases it in its own cleanup.
 */
export async function acquireOnlineFlag(): Promise<() => Promise<void>> {
  for (;;) {
    try {
      await mkdir(LOCK);
      return () => rm(LOCK, { recursive: true, force: true });
    } catch {
      const age = await stat(LOCK).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > STALE_MS) await rm(LOCK, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Stops online stock through the api, so the next test starts with no online location. A 409
 * `NO_ONLINE_LOCATION` (nothing is online) is the expected answer after a clean test and is ignored.
 */
export async function stopOnlineStock(request: APIRequestContext): Promise<void> {
  const answer = await api(request, 'POST', '/locations/online/stop', { reason: 'e2e cleanup' });
  if (answer.status === 409 && answer.body.code === 'NO_ONLINE_LOCATION') return;
  expect([200, 201], JSON.stringify(answer.body)).toContain(answer.status);
}

/**
 * Registers hooks for the tests of the surrounding describe that move the online flag for real:
 * each one holds the cross worker lock for its whole run and, pass or fail, stops online stock
 * before it lets go.
 */
export function useOnlineFlag(): void {
  let release: (() => Promise<void>) | undefined;
  test.beforeEach(async () => {
    // Waiting for another worker's test comes out of this test's own time.
    test.setTimeout(150_000);
    release = await acquireOnlineFlag();
  });
  test.afterEach(async ({ page }) => {
    try {
      await stopOnlineStock(page.request);
    } finally {
      await release?.();
      release = undefined;
    }
  });
}

/**
 * A location code that sorts before every code an earlier run made (the Locations list sorts by
 * code, `COLLATE "C"`), so a keyboard test reaches its row in a few Tab presses however many test
 * locations the shared database holds: `0`, then the seconds left until a far date (it shrinks as
 * time passes, so a newer code sorts first), then two random characters for tests in the same
 * second. 13 characters, inside the 16 a location code allows.
 */
export function firstSortingCode(): string {
  const left = String(1e10 - Math.floor(Date.now() / 1000)).padStart(10, '0');
  return `0${left}${randomUUID().slice(0, 2).toUpperCase()}`;
}

/** Presses Tab until `locator` has focus (at most `max` presses): keyboard only navigation. */
export async function tabTo(page: Page, locator: Locator, max = 120): Promise<void> {
  for (let step = 0; step < max; step += 1) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(locator).toBeFocused();
}

/** Tabs to `locator` and presses Enter on it. */
export async function pressEnterOn(page: Page, locator: Locator): Promise<void> {
  await tabTo(page, locator);
  await page.keyboard.press('Enter');
}

/** Tabs to a text field and types into it, as a keyboard user does. */
export async function typeInto(page: Page, locator: Locator, text: string): Promise<void> {
  await tabTo(page, locator);
  await page.keyboard.type(text);
}
