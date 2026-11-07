import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, textFor, type TextDirection, type Theme } from './support';

// Spec 0005 AC-28 and AC-34: the partner user's account inside the partner frame, in both
// languages and directions, with axe and by keyboard alone. `/api/partner/me` belongs to spec
// 0008 and does not exist yet, so the tests answer it themselves; nothing else is stubbed.
test.use({ storageState: { cookies: [], origins: [] } });

const THEMES: readonly Theme[] = ['light', 'dark'];
const DIRECTIONS: readonly TextDirection[] = ['ltr', 'rtl'];
const LANGUAGE = { ltr: 'en', rtl: 'ar' } as const;
/** The words a partner must never read, in English and Arabic (AC-34). */
const STAFF_WORDS = /staff|employee|موظف|طاقم|العاملين|(?<![\p{L}\p{M}])عامل(?![\p{L}\p{M}])/iu;

const PARTNER = {
  id: '0190c0de-0000-7000-8000-0000000000aa',
  name: 'Mona Showroom',
  email: 'mona@showroom.example',
  hats: ['partner'],
  permissions: ['partner.view_own', 'partner.submit_sales'],
  partnerAccountId: '0190c0de-0000-7000-8000-0000000000bb',
  phone: null,
  staffCode: null,
  language: null,
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'partner',
};

/** Answers `/api/partner/me`, and remembers every request it got. */
async function stubPartnerMe(page: Page) {
  const calls: Array<{ method: string; body: unknown }> = [];
  await page.route('**/api/partner/me', async (route) => {
    const request = route.request();
    const body = request.postData() ? (request.postDataJSON() as Record<string, string>) : null;
    calls.push({ method: request.method(), body });
    if (request.method() === 'PATCH') {
      return route.fulfill({ json: { ...PARTNER, ...body } });
    }
    return route.fulfill({ json: PARTNER });
  });
  return calls;
}

/** Opens the page and waits for the details form, which shows once `/api/partner/me` answered. */
async function openPartnerAccount(page: Page, language: 'en' | 'ar') {
  await page.goto(`/${language}/partner/account`);
  await expect(page.locator('#account-name')).toHaveValue(PARTNER.name);
}

test.describe('partner account page', () => {
  for (const theme of THEMES) {
    for (const dir of DIRECTIONS) {
      const language = LANGUAGE[dir];
      const where = `${theme}, ${dir}`;

      test(`has no axe violations and no staff wording in ${where}`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
        await stubPartnerMe(page);
        await openPartnerAccount(page, language);

        await expect(page.locator('html')).toHaveAttribute('dir', dir);
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          textFor(dir, 'account.title'),
        );
        await expect(page.locator('main')).not.toContainText(STAFF_WORDS);
        await expectNoAxeViolations(page);
      });

      test(`has no axe violations with a field error in ${where}`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
        await stubPartnerMe(page);
        await openPartnerAccount(page, language);
        await page.locator('#account-name').fill('');
        await page.locator('#account-name').press('Enter');
        await expect(page.locator('#account-name')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#account-name')).toBeFocused();

        await expectNoAxeViolations(page);
      });
    }
  }

  test('saves the name through /api/partner/me from the keyboard alone', async ({ page }) => {
    const calls = await stubPartnerMe(page);
    await openPartnerAccount(page, 'en');
    await page.locator('#account-name').focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Mona Keyboard');
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('status').filter({ hasText: 'Your details are saved.' }),
    ).toBeVisible();
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toMatchObject({ name: 'Mona Keyboard' });
  });

  test('never calls a staff api route and shows the email only', async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/')) apiCalls.push(pathname);
    });
    await stubPartnerMe(page);
    await openPartnerAccount(page, 'en');

    await expect(page.getByText(PARTNER.email)).toBeVisible();
    await expect(page.getByText('Role', { exact: true })).toHaveCount(0);
    expect(apiCalls.filter((path) => path === '/api/me' || path.startsWith('/api/staff'))).toEqual(
      [],
    );
  });

  test('the link to the other language keeps the page', async ({ page }) => {
    await stubPartnerMe(page);
    await openPartnerAccount(page, 'en');

    await page.getByRole('link', { name: 'العربية' }).click();

    await expect(page).toHaveURL(/\/ar\/partner\/account$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      textFor('rtl', 'account.title'),
    );
  });

  for (const language of ['en', 'ar'] as const) {
    test(`shows an error and the way home in the navigation when /api/partner/me fails, in ${language}`, async ({
      page,
    }) => {
      const dir = language === 'ar' ? 'rtl' : 'ltr';
      await page.route('**/api/partner/me', (route) =>
        route.fulfill({ status: 404, json: { code: 'NOT_FOUND', message: 'Not found' } }),
      );
      await page.goto(`/${language}/partner/account`);

      const main = page.getByRole('main');
      await expect(main.getByRole('alert')).toHaveText(textFor(dir, 'account.twoFactor.failed'));
      await expect(main.getByRole('status')).toHaveCount(0);
      await expect(page.locator('#account-name')).toHaveCount(0);
      await expect(main).not.toContainText(STAFF_WORDS);
      await expectNoAxeViolations(page);

      await page
        .getByRole('navigation')
        .getByRole('link', { name: textFor(dir, 'partner.nav.home') })
        .click();
      await expect(page).toHaveURL(new RegExp(`/${language}/partner$`));
    });
  }
});
