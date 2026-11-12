import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Hat } from '@ssdashboard/contracts';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { api } from './master-data-api';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0014 milestone 4, QA gaps beside customers-timeline.spec.ts (AC-14, AC-15, AC-13, AC-18):
// the lens per hat on the merge entry (support sees Undo but no audit link, a manager sees both and
// the link opens /audit on the record), the empty, error, and Load more error states, the Arabic
// plural forms of the signal counts, and the 375px layout (no sideways scroll, Load more reachable,
// the focused control not covered). A viewer with customers.view but no orders.view cannot be
// seeded: no hat holds one without the other (HAT_PERMISSIONS), so that lens is covered by the api
// e2e and the contracts unit test over built Access sets.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

interface MergedPair {
  survivorId: string;
  survivorName: string;
  mergedId: string;
  mergedName: string;
}

/** Two customers, the second merged into the first as the signed in person; extra phones page it. */
async function seedMergedPair(request: APIRequestContext, extraPhones = 0): Promise<MergedPair> {
  const tag = randomUUID().slice(0, 8);
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const make = async (name: string, phones: number) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO customers (name) VALUES ($1) RETURNING id`,
        [name],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('Seed returned no id');
      for (let i = 0; i < phones; i += 1) {
        await pool.query(
          `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
           VALUES ($1::uuid, $2, 'mobile', $3)`,
          [id, `+2010${digits()}`, i === 0],
        );
      }
      return id;
    };
    const survivorName = `Lens Sara ${tag}`;
    const mergedName = `Lens Dup ${tag}`;
    const survivorId = await make(survivorName, 1 + extraPhones);
    const mergedId = await make(mergedName, 1);
    const merged = await api(request, 'POST', '/customers/merges', {
      survivorId,
      mergedId,
      reasonCode: 'same_person',
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(201);
    return { survivorId, survivorName, mergedId, mergedName };
  } finally {
    await pool.end();
  }
}

/** Puts the survivor's id on a page-sized wait so a test can reach it by route. */
async function openProfile(page: Page, id: string, name: string) {
  await page.goto(`/customers/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await waitForPageHydration(page);
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  const language = dir === 'rtl' ? 'ar' : 'en';

  test.describe(`customer timeline checks in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let account: SeededAccount | undefined;

    async function signInAs(
      hats: Hat[],
      context: Parameters<typeof signInThroughApi>[0],
      baseURL: string | undefined,
    ) {
      account = await seedAccount({ hats, language });
      await signInThroughApi(context, account, baseURL ?? '');
    }

    test.afterEach(async () => {
      const done = account;
      account = undefined;
      await done?.remove().catch(() => undefined);
    });

    test('support sees Undo on the merge entry but no Open in audit link', async ({
      page,
      context,
      baseURL,
    }) => {
      await signInAs(['support'], context, baseURL);
      await useBrowserState(page, { dir });
      const pair = await seedMergedPair(context.request);
      await openProfile(page, pair.survivorId, pair.survivorName);
      const timeline = page.getByRole('region', { name: t('customers.profile.timeline.title') });
      const mergeEntry = timeline.getByRole('listitem').filter({
        has: page.getByText(t('customers.profile.timeline.kind.merge'), { exact: true }),
      });
      await expect(mergeEntry).toHaveCount(1);
      await expect(
        mergeEntry.getByRole('button', {
          name: t('customers.profile.timeline.undoLabel')
            .replace(/\s*\S+\s*\{\{date\}\}/, '')
            .replace('{{name}}', pair.mergedName),
        }),
      ).toBeVisible();
      await expect(
        mergeEntry.getByRole('link', { name: t('customers.profile.timeline.openInAudit') }),
      ).toHaveCount(0);
      // No audit link anywhere on the page for support.
      await expect(page.locator('a[href^="/audit"]')).toHaveCount(0);
      await expectNoAxeViolations(page);
    });

    test('a manager follows Open in audit to the record in /audit', async ({
      page,
      context,
      baseURL,
    }) => {
      await signInAs(['manager'], context, baseURL);
      await useBrowserState(page, { dir });
      const pair = await seedMergedPair(context.request);
      await openProfile(page, pair.survivorId, pair.survivorName);
      const timeline = page.getByRole('region', { name: t('customers.profile.timeline.title') });
      const link = timeline.getByRole('link', {
        name: t('customers.profile.timeline.openInAudit'),
      });
      await expect(link).toHaveCount(1);
      await link.click();
      await expect(page).toHaveURL(
        new RegExp(`/audit\\?recordType=customer&recordId=${pair.mergedId}`),
      );
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).not.toContainText(/no access|لا يمكنك/i);
    });

    test('the empty timeline shows a message, not a blank list', async ({
      page,
      context,
      baseURL,
    }) => {
      await signInAs(['manager'], context, baseURL);
      await useBrowserState(page, { dir });
      const pair = await seedMergedPair(context.request);
      await page.route(new RegExp(`/api/customers/${pair.survivorId}/timeline`), (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      await openProfile(page, pair.survivorId, pair.survivorName);
      await expect(page.getByText(t('customers.profile.timeline.emptyTitle'))).toBeVisible();
      await expect(page.getByText(t('customers.profile.timeline.emptyBody'))).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);
    });

    test('a failed timeline shows an error with Try again, which recovers', async ({
      page,
      context,
      baseURL,
    }) => {
      await signInAs(['manager'], context, baseURL);
      await useBrowserState(page, { dir });
      const pair = await seedMergedPair(context.request);
      const pattern = new RegExp(`/api/customers/${pair.survivorId}/timeline`);
      await page.route(pattern, (route) =>
        route.fulfill({ status: 500, json: { code: 'INTERNAL', message: 'boom' } }),
      );
      await openProfile(page, pair.survivorId, pair.survivorName);
      await expect(page.getByText(t('customers.profile.timeline.loadError'))).toBeVisible();
      await expectNoAxeViolations(page);
      await page.unroute(pattern);
      await page.getByRole('button', { name: t('customers.profile.timeline.retry') }).click();
      await expect(
        page
          .getByRole('region', { name: t('customers.profile.timeline.title') })
          .getByRole('listitem'),
      ).not.toHaveCount(0);
      await expect(page.getByText(t('customers.profile.timeline.loadError'))).toHaveCount(0);
    });

    test('a failed Load more keeps the first page, says so, and retry adds the rest once', async ({
      page,
      context,
      baseURL,
    }) => {
      test.setTimeout(60_000);
      await signInAs(['manager'], context, baseURL);
      await useBrowserState(page, { dir });
      // 27 phones + the merge entry: more than one page of 25.
      const pair = await seedMergedPair(context.request, 26);
      await openProfile(page, pair.survivorId, pair.survivorName);
      const timeline = page.getByRole('region', { name: t('customers.profile.timeline.title') });
      const entries = timeline.getByRole('listitem');
      await expect(entries).toHaveCount(25);
      const pattern = (url: URL) =>
        url.pathname.endsWith('/timeline') && url.searchParams.has('cursor');
      await page.route(pattern, (route) =>
        route.fulfill({ status: 500, json: { code: 'INTERNAL', message: 'boom' } }),
      );
      await timeline
        .getByRole('button', { name: t('customers.profile.timeline.loadMore') })
        .click();
      await expect(page.getByText(t('customers.profile.timeline.loadMoreError'))).toBeVisible();
      await expect(entries).toHaveCount(25);
      await page.unroute(pattern);
      await timeline.getByRole('button', { name: t('customers.profile.timeline.retry') }).click();
      // 1 merge + 27 phones (1 primary + 26 more) + the merged customer's phone moved: 28 or 29.
      await expect(entries.nth(25)).toBeVisible();
      const count = await entries.count();
      expect(count).toBeGreaterThan(25);
      expect(count).toBeLessThanOrEqual(30);
      // No entry repeats: every item key (kind plus visible text of the row) is distinct per row id.
      const texts = await entries.allInnerTexts();
      expect(new Set(texts).size).toBe(texts.length);
      await expect(
        timeline.getByRole('button', { name: t('customers.profile.timeline.loadMore') }),
      ).toHaveCount(0);
    });

    test('the signal counts use the right plural form (1, 2, 3, 11, 100)', async ({
      page,
      context,
      baseURL,
    }) => {
      await signInAs(['manager'], context, baseURL);
      await useBrowserState(page, { dir });
      const pair = await seedMergedPair(context.request);
      let refusals = 3;
      await page.route(new RegExp(`/api/customers/${pair.survivorId}(\\?.*)?$`), async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        body['signal'] = { refusals, returns: 1, windowDays: 180, suggestedKind: 'refuser' };
        await route.fulfill({ response, json: body });
      });
      const seen: string[] = [];
      for (const count of [1, 2, 3, 11, 100]) {
        refusals = count;
        await openProfile(page, pair.survivorId, pair.survivorName);
        const suggestion = page.getByRole('region', { name: t('customers.profile.signal.title') });
        await expect(suggestion).toBeVisible();
        const first = suggestion.getByRole('listitem').first();
        // Arabic one and two have no digit (a word instead), every other form carries the count.
        if (count > 2) await expect(first).toContainText(String(count));
        else await expect(first).toContainText(/\S/);
        seen.push(await first.innerText());
      }
      if (dir === 'rtl') {
        // Arabic: one, two, few (3 to 10), many (11 to 99), other (100): five different sentences.
        expect(new Set(seen.map((s) => s.replace(/\d+/g, '#'))).size).toBe(5);
        expect(seen[0]).toContain('طلب واحد');
        expect(seen[1]).toContain('طلبان');
      } else {
        expect(seen[0]).toMatch(/^1 order refused/);
        expect(seen[1]).toMatch(/^2 orders refused/);
      }
    });

    test('the profile reads and works at 375px (no sideways scroll, Load more reachable)', async ({
      page,
      context,
      baseURL,
    }) => {
      test.setTimeout(60_000);
      await signInAs(['manager'], context, baseURL);
      await useBrowserState(page, { dir });
      await page.setViewportSize({ width: 375, height: 740 });
      const pair = await seedMergedPair(context.request, 26);
      await openProfile(page, pair.survivorId, pair.survivorName);
      const timeline = page.getByRole('region', { name: t('customers.profile.timeline.title') });
      await expect(timeline.getByRole('listitem')).toHaveCount(25);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const loadMore = timeline.getByRole('button', {
        name: t('customers.profile.timeline.loadMore'),
      });
      await loadMore.scrollIntoViewIfNeeded();
      await loadMore.focus();
      const covered = await loadMore.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          visible: box.top >= 0 && box.bottom <= window.innerHeight,
          hit: top === element || element.contains(top),
        };
      });
      expect(covered).toEqual({ visible: true, hit: true });
      await expectNoAxeViolations(page);
    });
  });
}
