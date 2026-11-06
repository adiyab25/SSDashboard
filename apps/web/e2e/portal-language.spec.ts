import { expect, test } from '@playwright/test';
import { ar } from '@ssdashboard/i18n/ar';
import { en } from '@ssdashboard/i18n';
import { expectNoAxeViolations, languageCookie, stubConfig } from './support';

// Spec 0004 AC-16: the portal and partner pages carry the language in the URL and render it on
// the server. These tests run against anonymous visitors, on every project.
test.use({ storageState: { cookies: [], origins: [] } });

const AUDIENCES = [
  { name: 'portal', path: '/returns', key: 'returns' as const },
  { name: 'partner', path: '/partner', key: 'home' as const },
];

/** Where a redirect points; the server may send a path or a full address. */
function redirectTarget(location: string | undefined): URL {
  return new URL(location ?? '', 'http://placeholder.invalid');
}

/** The h1 text of an audience page in a language, read from the catalog the app ships. */
function titleOf(audience: (typeof AUDIENCES)[number], language: 'en' | 'ar'): string {
  const catalog = language === 'ar' ? ar : en;
  const group = audience.name === 'portal' ? catalog.portal : catalog.partner;
  const page = (group as Record<string, { title: string }>)[audience.key];
  if (!page) throw new Error('no catalog text');
  return page.title;
}

test.describe('scripts blocked: the server alone renders the language', () => {
  test.use({ javaScriptEnabled: false });

  for (const audience of AUDIENCES) {
    for (const [language, dir] of [
      ['ar', 'rtl'],
      ['en', 'ltr'],
    ] as const) {
      test(`${language}${audience.path} is ${dir} with its own text and no data-i18n`, async ({
        page,
      }) => {
        const response = await page.goto(`/${language}${audience.path}`);

        expect(response?.status()).toBe(200);
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await expect(page.locator('html')).toHaveAttribute('dir', dir);
        await expect(page.locator('html')).not.toHaveAttribute('data-i18n', /.*/);
        await expect(page.locator('[data-i18n]')).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          titleOf(audience, language),
        );
        expect(await response?.text()).not.toContain('data-i18n');
      });
    }

    test(`the ${audience.name} language link works without scripts`, async ({ page }) => {
      await page.goto(`/ar${audience.path}`);
      await page.getByRole('link', { name: 'English' }).click();

      await expect(page).toHaveURL(new RegExp(`/en${audience.path}$`));
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      expect(await languageCookie(page)).toBe('en');
    });
  }
});

test.describe('the redirect for a path with no language', () => {
  for (const audience of AUDIENCES) {
    test(`${audience.path} follows Accept-Language ar-EG to Arabic`, async ({ request }) => {
      const response = await request.get(audience.path, {
        maxRedirects: 0,
        headers: { 'accept-language': 'ar-EG,ar;q=0.9' },
      });

      expect(response.status()).toBe(307);
      expect(redirectTarget(response.headers()['location']).pathname).toBe(`/ar${audience.path}`);
    });

    test(`${audience.path} follows the saved language over the browser`, async ({
      page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: 'ss_lang', value: 'en', url: baseURL ?? '' }]);
      const response = await page.request.get(`${audience.path}?order=7`, {
        maxRedirects: 0,
        headers: { 'accept-language': 'ar-EG,ar;q=0.9' },
      });

      expect(response.status()).toBe(307);
      const location = redirectTarget(response.headers()['location']);
      expect(location.pathname + location.search).toBe(`/en${audience.path}?order=7`);
    });

    test(`${audience.path} with no cookie and no header goes to Arabic`, async ({ request }) => {
      const response = await request.get(audience.path, {
        maxRedirects: 0,
        headers: { 'accept-language': '' },
      });

      expect(response.status()).toBe(307);
      expect(redirectTarget(response.headers()['location']).pathname).toBe(`/ar${audience.path}`);
    });
  }

  test.describe('a browser that asks for Arabic', () => {
    test.use({ locale: 'ar-EG' });

    test('opening /returns lands on the Arabic page', async ({ page }) => {
      await page.goto('/returns');

      await expect(page).toHaveURL(/\/ar\/returns$/);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    });
  });
});

test.describe('a client language saved in the cookie (AC-23)', () => {
  for (const audience of AUDIENCES) {
    test(`${audience.path} with ss_lang=fr goes to English and keeps the cookie`, async ({
      page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: 'ss_lang', value: 'fr', url: baseURL ?? '' }]);
      const response = await page.request.get(audience.path, {
        maxRedirects: 0,
        headers: { 'accept-language': 'ar-EG,ar;q=0.9' },
      });

      expect(response.status()).toBe(307);
      expect(redirectTarget(response.headers()['location']).pathname).toBe(`/en${audience.path}`);

      await page.goto(audience.path);
      await expect(page).toHaveURL(new RegExp(`/en${audience.path}$`));
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      expect(await languageCookie(page)).toBe('fr');
    });
  }
});

test.describe('paths that only look like a language', () => {
  for (const path of ['/english/returns', '/en-US/partner', '/account/returns']) {
    test(`${path} is a real 404`, async ({ request }) => {
      expect((await request.get(path, { maxRedirects: 0 })).status()).toBe(404);
    });
  }

  test('the redirect is never cached', async ({ request }) => {
    const response = await request.get('/returns', { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers()['cache-control']).toBe('private, no-store');
  });
});

test.describe('a language that is not served', () => {
  for (const audience of AUDIENCES) {
    test(`/fr${audience.path} is a real 404`, async ({ page }) => {
      const response = await page.goto(`/fr${audience.path}`);

      expect(response?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    });
  }
});

test.describe('the language link and the cookie', () => {
  for (const audience of AUDIENCES) {
    test(`${audience.name}: the link goes to the other language and saves the choice`, async ({
      page,
    }) => {
      await page.goto(`/ar${audience.path}`);
      expect(await languageCookie(page)).toBe('ar');

      const link = page.getByRole('link', { name: 'English' });
      await expect(link).toHaveAttribute('href', `/en${audience.path}`);
      await expect(link).toHaveAttribute('hreflang', 'en');
      await expect(link).toHaveAttribute('lang', 'en');
      await link.click();

      await expect(page).toHaveURL(new RegExp(`/en${audience.path}$`));
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      expect(await languageCookie(page)).toBe('en');
      // The saved choice now decides the unprefixed path.
      await page.goto(audience.path);
      await expect(page).toHaveURL(new RegExp(`/en${audience.path}$`));
    });
  }
});

test.describe('hydration and accessibility', () => {
  for (const audience of AUDIENCES) {
    for (const language of ['en', 'ar'] as const) {
      test(`${language}${audience.path}: no hydration warning, one h1, no axe violations at 375px`, async ({
        page,
      }) => {
        const problems: string[] = [];
        page.on('console', (message) => {
          if (/hydrat|did not match/i.test(message.text())) problems.push(message.text());
        });
        page.on('pageerror', (error) => problems.push(error.message));
        // The production server of this suite has no api behind it; an unread 404 body would keep
        // the network busy forever, so the one call the page makes is answered here.
        await stubConfig(page);
        await page.setViewportSize({ width: 375, height: 740 });

        await page.goto(`/${language}${audience.path}`);
        await page.waitForLoadState('networkidle');

        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          titleOf(audience, language),
        );
        await expect(page.locator('html')).not.toHaveAttribute('data-i18n', /.*/);
        await expectNoAxeViolations(page);
        expect(problems).toEqual([]);
      });
    }
  }
});
