import { expect, test, type Page } from '@playwright/test';
import type { LicenseSummary, PostLicenseAnswer } from '@ssdashboard/contracts';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0009 milestone 4 (AC-19): the executing steps that resume after a renewal, named in the
// license section (steps waiting) and on the upload answer (steps resuming), in English and
// Arabic, by keyboard, axe clean. Both license calls are answered from the browser, so nothing is
// recorded and the shared e2e database stays as it was. The banner's stops and continues parts
// are not covered here: they come from the real module registry in the browser bundle, which
// names no Operations capability yet, so they render nothing; `license-notice-work.spec.tsx`
// covers them with a mocked registry.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** A step key of the settings registry, so the screen names it by its label. */
const STEP = 'currency';

const summary: LicenseSummary = {
  bundles: [
    {
      bundle: 'warehouse',
      phase: 'active',
      perpetual: true,
      expiresOn: null,
      daysLeft: null,
      lapsesAt: null,
    },
    {
      bundle: 'operations',
      phase: 'off',
      perpetual: false,
      expiresOn: '2026-01-01',
      daysLeft: -300,
      lapsesAt: '2026-01-15T22:00:00.000Z',
    },
  ],
  lastCheck: null,
  licenses: [],
  notices: [],
  resumingSteps: [STEP],
};

/** Answers the license calls from the browser: GET with waiting steps, POST with resuming ones. */
async function mockLicense(page: Page) {
  await page.route('**/api/platform/license', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: summary });
    const answer: PostLicenseAnswer = { summary, changed: true, resumingSteps: [STEP] };
    return route.fulfill({ json: answer });
  });
}

for (const { dir, name } of LANGUAGES) {
  test(`names the steps that resume, in the section and on the upload answer, in ${name} (AC-19)`, async ({
    page,
  }) => {
    await mockLicense(page);
    await useBrowserState(page, { dir });
    await page.goto('/settings');
    await expect(
      page.getByRole('heading', { level: 2, name: textFor(dir, 'settings.sections.license') }),
    ).toBeVisible();
    await waitForPageHydration(page);

    const section = page.getByRole('region', { name: textFor(dir, 'settings.sections.license') });
    await expect(
      section.getByText(textFor(dir, 'settings.license.waitingIntro'), { exact: true }),
    ).toBeVisible();
    await expect(
      section
        .getByRole('listitem')
        .filter({ hasText: textFor(dir, 'settings.entries.currency.label') }),
    ).toBeVisible();

    // Open the upload dialog by keyboard: focus the button, then press Enter.
    await page.getByRole('button', { name: textFor(dir, 'settings.license.upload.open') }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', {
      name: textFor(dir, 'settings.license.upload.title'),
    });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(textFor(dir, 'settings.license.upload.fileLabel')).setInputFiles({
      name: 'license.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"keyId":"dev-1"}'),
    });
    await dialog
      .getByRole('button', { name: textFor(dir, 'settings.license.upload.submit'), exact: true })
      .click();

    const result = page.getByRole('dialog', {
      name: textFor(dir, 'settings.license.upload.resumedTitle'),
    });
    await expect(result).toBeVisible();
    await expect(
      result.getByText(textFor(dir, 'settings.license.upload.resumingIntro'), { exact: true }),
    ).toBeVisible();
    await expect(
      result.getByText(textFor(dir, 'settings.license.upload.resumingNote'), { exact: true }),
    ).toBeVisible();
    await expect(result.getByRole('listitem')).toHaveText(
      textFor(dir, 'settings.entries.currency.label'),
    );
    const done = result.getByRole('button', { name: textFor(dir, 'settings.license.upload.done') });
    await expect(done).toBeFocused();
    await expectNoAxeViolations(page);

    await page.keyboard.press('Enter');
    await expect(result).toBeHidden();
  });
}
