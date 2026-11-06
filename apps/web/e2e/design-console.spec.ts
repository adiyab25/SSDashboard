import { expect, test } from '@playwright/test';
import { openShell, useBrowserState } from './support';

// Spec 0003: the shell, the gallery, and the phone dashboard sample write nothing to the console
// (no React key warning, no hydration mismatch, no failed request) in either language.
for (const language of ['en', 'ar'] as const) {
  for (const path of ['/', '/design', '/design/phone-dashboard']) {
    test(`${path} in ${language} logs no console error or warning`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'desktop project only');
      const messages: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          messages.push(`${message.type()}: ${message.text().slice(0, 200)}`);
        }
      });
      page.on('pageerror', (error) => messages.push(`pageerror: ${error.message.slice(0, 200)}`));
      await useBrowserState(page, { theme: 'light', language });

      if (path === '/design/phone-dashboard') await page.goto(path);
      else await openShell(page, path);
      await page.evaluate(() => document.fonts.ready);
      // Dev servers keep a socket open, so network idle never settles; give late warnings a moment.
      await page.waitForTimeout(750);

      expect(messages).toEqual([]);
    });
  }
}
