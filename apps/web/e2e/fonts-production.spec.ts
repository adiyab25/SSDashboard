import { expect, test } from '@playwright/test';

// Spec 0003 AC-13 and AC-23 (as amended 2026-11-06): on a production build every font is a file
// the app serves itself, Arabic pages load the Arabic face, and text shows before a font arrives.
test.describe('fonts on a production build', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ['/en/returns', '/ar/returns']) {
    test(`${path}: no request leaves the origin, and fonts are same origin woff2 files`, async ({
      page,
      baseURL,
    }) => {
      const origin = new URL(baseURL ?? '').host;
      const foreign = new Set<string>();
      const fontFiles: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.host !== origin) foreign.add(url.host);
        if (request.resourceType() === 'font') fontFiles.push(url.pathname);
      });

      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);

      expect([...foreign]).toEqual([]);
      expect(fontFiles.length).toBeGreaterThan(0);
      for (const file of fontFiles) expect(file).toMatch(/^\/_next\/static\/media\/.+\.woff2$/);
    });
  }

  test('an Arabic page loads Noto Sans Arabic, and no page preloads it', async ({ page }) => {
    const fontFiles: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'font') fontFiles.push(request.url());
    });

    await page.goto('/ar/returns');
    await page.evaluate(() => document.fonts.ready);
    const arabic = await page.evaluate(() =>
      [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family),
    );
    expect(arabic.some((family) => /Noto Sans Arabic/i.test(family))).toBe(true);
    expect(fontFiles.some((url) => /noto_sans_arabic/.test(url))).toBe(true);

    // Not preloaded (`preload: false`): an English page still fetches it, on use, for the
    // "العربية" language link, so only the preload hint is asserted, never the download.
    for (const path of ['/en/returns', '/ar/returns']) {
      await page.goto(path);
      const preloaded = await page.evaluate(() =>
        [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) =>
          link.getAttribute('href'),
        ),
      );
      expect(
        preloaded.some((href) => /noto_sans_arabic/.test(href ?? '')),
        path,
      ).toBe(false);
    }
  });

  test('every font face swaps, so text shows before the file arrives', async ({ page }) => {
    await page.goto('/ar/returns');
    const displays = await page.evaluate(() =>
      [...document.fonts].map((face) => ({ family: face.family, display: face.display })),
    );
    expect(displays.length).toBeGreaterThan(0);
    for (const face of displays) expect(face.display, face.family).toBe('swap');
  });
});
