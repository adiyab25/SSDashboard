import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LicenseSummary } from '@ssdashboard/contracts';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { signedWarehouseLicense } from './license-file';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0009 milestone 2 (AC-17, AC-20, AC-25, AC-26): the Modules and license section of /settings
// and the manager's license banner. A manager uploads a license file in English and Arabic (and
// by keyboard); a refused file gets its own sentence; the section reads correctly; the banner
// shows each level in words; a person without `settings.manage` sees no banner and asks the api
// for no license; axe is clean with the dialog and the banner open.
//
// The upload tests write: an upload is append only and permanent, so they upload one license that
// shrinks nothing (Warehouse with no expiry, id `E2E-NOOP-0001`, see `license-file.ts`), and they
// run on the desktop project only so two projects never upload at once. `global-setup.ts` records
// that license before any test, so here it is always already recorded. The banner tests answer
// `GET /api/platform/license` from the browser, so they change nothing.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

const desktopOnly = (name: string) =>
  test.skip(name !== 'desktop', 'uploads a license: desktop project only');

/** Opens /settings and waits for the license section's plans. */
async function openLicense(page: Page, dir: TextDirection) {
  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { level: 1, name: textFor(dir, 'settings.title') }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: textFor(dir, 'settings.sections.license') }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: textFor(dir, 'settings.license.bundles.operations') }),
  ).toBeVisible();
  await waitForPageHydration(page);
}

/** Opens the upload dialog from the section's button. */
async function openUpload(page: Page, dir: TextDirection) {
  await page.getByRole('button', { name: textFor(dir, 'settings.license.upload.open') }).click();
  const dialog = page.getByRole('dialog', { name: textFor(dir, 'settings.license.upload.title') });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Chooses a file in the dialog's file input from text. */
const chooseFile = (dialog: Locator, dir: TextDirection, text: string) =>
  dialog.getByLabel(textFor(dir, 'settings.license.upload.fileLabel')).setInputFiles({
    name: 'license.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });

/** The answer of the upload call, read from the network. */
const uploadAnswer = (page: Page) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/platform/license' &&
      response.request().method() === 'POST',
  );

/** A summary with one Operations notice, as the api sends it near an expiry. */
function summaryWithNotice(notice: LicenseSummary['notices'][number]): LicenseSummary {
  return {
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
        phase: notice.phase,
        perpetual: false,
        expiresOn: notice.expiresOn,
        daysLeft: notice.daysLeft,
        lapsesAt: notice.lapsesAt,
      },
    ],
    lastCheck: null,
    licenses: [],
    notices: [notice],
  };
}

test.describe('as a manager', () => {
  for (const { dir, name } of LANGUAGES) {
    test(`reads the plans, the last check and the recorded licenses in ${name} (AC-25, AC-26)`, async ({
      page,
    }) => {
      await useBrowserState(page, { dir });
      await openLicense(page, dir);
      await expect(page.locator('h1')).toHaveCount(1);

      const section = page.getByRole('region', {
        name: textFor(dir, 'settings.sections.license'),
      });
      await expect(section).toHaveAttribute('id', 'license');
      await expect(
        section.getByRole('heading', { name: textFor(dir, 'settings.license.bundles.core') }),
      ).toBeVisible();
      await expect(
        section.getByText(textFor(dir, 'settings.license.coreAlways'), { exact: true }),
      ).toBeVisible();
      for (const bundle of ['warehouse', 'operations'] as const) {
        const row = section.getByRole('listitem').filter({
          has: page.getByRole('heading', {
            name: textFor(dir, `settings.license.bundles.${bundle}`),
          }),
        });
        await expect(row).toHaveCount(1);
        // A phase word and its sentence, never a colour alone.
        await expect(row).toContainText(
          new RegExp(
            (['active', 'expiring', 'grace', 'wind_down', 'off', 'not_licensed'] as const)
              .map((phase) => textFor(dir, `settings.license.phases.${phase}`))
              .join('|'),
          ),
        );
      }
      await expect(
        section.getByRole('heading', { name: textFor(dir, 'settings.license.lastCheckHeading') }),
      ).toBeVisible();
      await expect(
        section.getByRole('heading', { name: textFor(dir, 'settings.license.recordedHeading') }),
      ).toBeVisible();
    });

    test(`uploads a license file in ${name}, then the same file says nothing changed (AC-20)`, async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      const license = await signedWarehouseLicense();
      await useBrowserState(page, { dir });
      await openLicense(page, dir);
      const recorded = textFor(dir, 'settings.license.upload.recorded');
      const unchanged = textFor(dir, 'settings.license.upload.unchanged');

      // First upload here: global setup already recorded this license, so it says nothing changed.
      // The words still follow the api's `changed`; the recorded words of a first upload are covered
      // by `license-upload-dialog.spec.tsx` and the api's `license.e2e-spec.ts`.
      let dialog = await openUpload(page, dir);
      await chooseFile(dialog, dir, license);
      await expect(dialog.getByText('license.json')).toBeVisible();
      let answer = uploadAnswer(page);
      await dialog
        .getByRole('button', { name: textFor(dir, 'settings.license.upload.submit'), exact: true })
        .click();
      const first = (await (await answer).json()) as { changed: boolean };
      await expect(dialog).toBeHidden();
      await expect(page.getByText(first.changed ? recorded : unchanged).last()).toBeVisible();
      await expect(
        page.getByRole('button', { name: textFor(dir, 'settings.license.upload.open') }),
      ).toBeFocused();
      // The license is in the recorded list, from the upload or from before.
      await expect(page.getByText('E2E-NOOP-0001')).toBeVisible();

      // Second upload of the very same file: always nothing new.
      dialog = await openUpload(page, dir);
      await chooseFile(dialog, dir, license);
      answer = uploadAnswer(page);
      await dialog
        .getByRole('button', { name: textFor(dir, 'settings.license.upload.submit'), exact: true })
        .click();
      const second = (await (await answer).json()) as { changed: boolean };
      expect(second.changed).toBe(false);
      await expect(dialog).toBeHidden();
      await expect(page.getByText(unchanged).last()).toBeVisible();
    });

    test(`names the refusal of a file that is not a license in ${name} (AC-20)`, async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await useBrowserState(page, { dir });
      await openLicense(page, dir);
      const dialog = await openUpload(page, dir);
      const input = dialog.getByLabel(textFor(dir, 'settings.license.upload.fileLabel'));

      // Nothing chosen: the sentence shows and focus goes to the input, with nothing sent.
      await dialog
        .getByRole('button', { name: textFor(dir, 'settings.license.upload.submit'), exact: true })
        .click();
      await expect(
        dialog.getByText(textFor(dir, 'settings.license.upload.errors.fileRequired')),
      ).toBeVisible();
      await expect(input).toBeFocused();

      await chooseFile(dialog, dir, '{"not":"a license"}');
      await dialog
        .getByRole('button', { name: textFor(dir, 'settings.license.upload.submit'), exact: true })
        .click();
      const sentence = textFor(dir, 'settings.license.upload.errors.bad_format');
      await expect(dialog.getByText(sentence)).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveAccessibleDescription(sentence);
      await expect(dialog).toBeVisible();
    });
  }

  test('uploads with the keyboard only after the file is chosen, and Escape returns focus', async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    const license = await signedWarehouseLicense();
    await useBrowserState(page, { dir: 'ltr' });
    await openLicense(page, 'ltr');

    const opener = page.getByRole('button', {
      name: textFor('ltr', 'settings.license.upload.open'),
    });
    await opener.focus();
    await page.keyboard.press('Enter');
    let dialog = page.getByRole('dialog', {
      name: textFor('ltr', 'settings.license.upload.title'),
    });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await page.keyboard.press('Enter');
    dialog = page.getByRole('dialog', { name: textFor('ltr', 'settings.license.upload.title') });
    await expect(dialog).toBeVisible();
    const input = dialog.getByLabel(textFor('ltr', 'settings.license.upload.fileLabel'));
    const submit = dialog.getByRole('button', {
      name: textFor('ltr', 'settings.license.upload.submit'),
      exact: true,
    });
    // Tab to the file input (the operating system's file picker cannot be driven in a test, so
    // the file itself is set), then Tab on to Upload and press Enter.
    for (
      let step = 0;
      step < 6 && !(await input.evaluate((node) => node === document.activeElement));
      step += 1
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(input).toBeFocused();
    await chooseFile(dialog, 'ltr', license);
    for (
      let step = 0;
      step < 4 && !(await submit.evaluate((node) => node === document.activeElement));
      step += 1
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(submit).toBeFocused();
    const answer = uploadAnswer(page);
    await page.keyboard.press('Enter');
    await answer;
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  for (const { dir, name } of LANGUAGES) {
    test(`has no axe violations in ${name}, with the upload dialog and a refusal shown`, async ({
      page,
      viewport,
    }) => {
      test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the accessibility sweep');
      await useBrowserState(page, { dir });
      await openLicense(page, dir);
      await expectNoAxeViolations(page);

      const dialog = await openUpload(page, dir);
      await expectNoAxeViolations(page);
      await dialog
        .getByRole('button', { name: textFor(dir, 'settings.license.upload.submit'), exact: true })
        .click();
      await expect(
        dialog.getByText(textFor(dir, 'settings.license.upload.errors.fileRequired')),
      ).toBeVisible();
      await expectNoAxeViolations(page);
    });
  }

  const LEVELS = [
    { level: 'info', phase: 'expiring', daysLeft: 20, key: 'expiring' },
    { level: 'warning', phase: 'grace', daysLeft: -3, key: 'grace' },
    { level: 'critical', phase: 'wind_down', daysLeft: -30, key: 'wind_down' },
  ] as const;

  for (const { dir, name } of LANGUAGES) {
    for (const { level, phase, daysLeft, key } of LEVELS) {
      test(`shows the ${level} banner for ${phase} in ${name}, links to the section and is axe clean (AC-17)`, async ({
        page,
        viewport,
      }) => {
        const notice = {
          bundle: 'operations',
          phase,
          level,
          expiresOn: '2026-12-01',
          daysLeft,
          lapsesOn: '2026-12-16',
          lapsesAt: '2026-12-15T22:00:00.000Z',
          windDownEndsOn: '2027-02-14',
        } as const;
        await page.route('**/api/platform/license', (route) =>
          route.request().method() === 'GET'
            ? route.fulfill({ json: summaryWithNotice(notice) })
            : route.continue(),
        );
        await useBrowserState(page, { dir });
        await page.goto('/');
        const banner = page.getByRole('region', {
          name: textFor(dir, 'settings.license.banner.label'),
        });
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(textFor(dir, `settings.license.banner.levels.${level}`));
        // A distinctive part of the sentence after its first placeholder, with the expiry date
        // the formatter wrote (2026-12-01 is "1 Dec 2026" in English).
        const afterBundle = textFor(dir, `settings.license.banner.${key}`)
          .split('{{bundle}}')[1]
          ?.split('{{')[0]
          ?.trim();
        expect(afterBundle, 'the sentence has text after the plan name').toBeTruthy();
        await expect(banner).toContainText(afterBundle ?? '');
        // One formatted date: Western digits and the year in both languages; the whole date in
        // English, where the format is known ("1 Dec 2026" for an expiry of 2026-12-01).
        await expect(banner).toContainText(key === 'wind_down' ? '2027' : '2026');
        if (dir === 'ltr' && key !== 'wind_down') await expect(banner).toContainText('1 Dec 2026');
        if (dir === 'ltr' && key === 'wind_down') await expect(banner).toContainText('14 Feb 2027');
        // Western digits in both languages, the date through the formatter.
        await expect(banner).not.toContainText(/[٠-٩]/);
        const link = banner.getByRole('link', {
          name: textFor(dir, 'settings.license.banner.link'),
        });
        await expect(link).toHaveAttribute('href', '/settings#license');
        if ((viewport?.width ?? 0) >= 1000) await expectNoAxeViolations(page);

        await link.click();
        await expect(page).toHaveURL(/\/settings#license$/);
      });
    }
  }
});

test.describe('a person without settings.manage', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let person: SeededAccount | undefined;

  test.afterEach(async () => {
    const seeded = person;
    person = undefined;
    await seeded?.remove();
  });

  test('sees no license banner and the shell asks the api for no license (AC-17)', async ({
    page,
    context,
    baseURL,
  }) => {
    person = await seedAccount({ hats: ['support'], language: 'en' });
    await signInThroughApi(context, person, baseURL ?? '');
    await useBrowserState(page, { dir: 'ltr' });
    const asked: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/platform/license')) asked.push(path);
    });

    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(person.name) })).toBeVisible();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(
      page.getByRole('region', { name: textFor('ltr', 'settings.license.banner.label') }),
    ).toHaveCount(0);
    expect(asked).toEqual([]);
  });
});
