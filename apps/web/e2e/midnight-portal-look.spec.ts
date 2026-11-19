import { expect, test, type Page } from '@playwright/test';
import { COMBINATIONS, measureFields, openPath, settleAnimations } from './look-support';
import { expectNoAxeViolations, stubConfig, useBrowserState as setBrowserState } from './support';

// Spec 0025 milestone M7 (AC-14, AC-19, AC-21, AC-22; spec 0003 AC-19 and AC-23): the portal
// returns screens and their two previews, the partner home, its preview, and the partner account
// in the Midnight look, anonymous, in dark and light, English and Arabic. One page load per
// surface and combination runs every check at 1280px, then narrows the same page to the portal's
// 320px baseline and runs the width dependent ones again, so the phone project (a 375px device
// that would only repeat them) is skipped. The font requests of the Arabic portal are checked
// once, apart.
test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

/** The accent of the sample brand on `/returns/preview/brand` (`brand-accent-limits.spec.ts`). */
const ACCENT = 'rgb(10, 124, 57)';

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

interface Surface {
  tag: string;
  path: string;
  /** What paints the sample accent (element names in order), or null for the primary fallback. */
  accent: string[] | null;
  /** The partner frame: it has a top navigation. */
  partner: boolean;
  /** Fields the page shows (the preview input, the account form). */
  fields: boolean;
  /** Waits for what the page loads, so no skeleton is measured. */
  ready?: (page: Page) => Promise<void>;
}

const SURFACES: Surface[] = [
  { tag: 'returns', path: '/returns', accent: null, partner: false, fields: false },
  {
    tag: 'brand',
    path: '/returns/preview/brand',
    accent: ['div', 'img', 'button[button]'],
    partner: false,
    fields: true,
  },
  {
    tag: 'rejected',
    path: '/returns/preview/rejected',
    accent: null,
    partner: false,
    fields: true,
  },
  { tag: 'partner', path: '/partner', accent: null, partner: true, fields: false },
  {
    tag: 'partner-preview',
    path: '/partner/preview',
    accent: ['img'],
    partner: true,
    fields: false,
  },
  {
    tag: 'partner-account',
    path: '/partner/account',
    accent: null,
    partner: true,
    fields: true,
    ready: (page) => expect(page.locator('#account-name')).toHaveValue(PARTNER.name),
  },
];

/** The colour a role token paints (`--brand`, `--primary`, `--background`) as a computed rgb string. */
async function paintOf(page: Page, variable: string, property: 'backgroundColor' | 'color') {
  return page.evaluate(
    ([name, prop]) => {
      const probe = document.createElement('div');
      probe.style[prop as 'color'] = `var(${name})`;
      document.body.append(probe);
      const value = getComputedStyle(probe)[prop as 'color'];
      probe.remove();
      return value;
    },
    [variable, property] as const,
  );
}

/**
 * Presses Tab through the page and reads each focused element: it must show a solid outline of at
 * least 2px (the inset ring of the partner links is an outline too, never a shadow), and be at
 * least 24px each way. It also fails when Tab reached fewer elements than the page has focusables,
 * so a walk that visits nothing cannot pass.
 */
async function walkFocus(page: Page) {
  const count = await page.evaluate(
    () =>
      [
        ...document.querySelectorAll(
          'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ),
      ].filter((element) => !element.closest('nextjs-portal')).length,
  );
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const problems: string[] = [];
  const visited = new Set<number>();
  // A few presses more than there are elements: the development overlay's own tab stops take some.
  for (let step = 0; step < count + 4; step++) {
    await page.keyboard.press('Tab');
    await settleAnimations(page);
    const look = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body || element.closest('nextjs-portal')) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        index: [...document.querySelectorAll('*')].indexOf(element),
        name: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} "${(element.textContent ?? '').trim().slice(0, 24)}"`,
        outline: style.outlineStyle !== 'none' ? parseFloat(style.outlineWidth) : 0,
        width: rect.width,
        height: rect.height,
      };
    });
    if (!look) continue;
    visited.add(look.index);
    if (look.outline < 2) problems.push(`${look.name}: no focus ring`);
    // The skip link is 1px until it takes focus, and shows full size then; inline text links are
    // exempt from the 24px rule, and axe checks those.
    if (look.width < 24 || look.height < 24)
      problems.push(`${look.name}: ${look.width}x${look.height}`);
  }
  expect(count, 'the page has focusable elements').toBeGreaterThan(0);
  expect(visited.size, 'Tab reached every focusable element').toBeGreaterThanOrEqual(count);
  return problems;
}

/** What paints the brand accent in any colour property, as element names, in document order. */
async function paintedWithAccent(page: Page) {
  return page.evaluate((accent) => {
    const found: string[] = [];
    for (const element of document.querySelectorAll('body *')) {
      const style = getComputedStyle(element);
      const borders = ['Top', 'Bottom'].filter(
        (side) => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
      );
      const hit =
        style.backgroundColor === accent ||
        style.color === accent ||
        (borders.length > 0 &&
          (style.borderTopColor === accent || style.borderBottomColor === accent)) ||
        style.fill === accent ||
        style.stroke === accent;
      if (hit) {
        const slot = element.getAttribute('data-slot') ?? element.getAttribute('data-testid');
        found.push(`${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}`);
      }
    }
    return found;
  }, ACCENT);
}

for (const { theme, dir, tag } of COMBINATIONS) {
  const language = dir === 'rtl' ? 'ar' : 'en';
  test.describe(`the portal and partner surfaces in ${tag}`, () => {
    for (const surface of SURFACES) {
      test(`${surface.path}: axe, focus, targets, fields, brand, nav and one main action`, async ({
        page,
      }) => {
        test.setTimeout(90_000);
        await stubConfig(page);
        if (surface.partner) {
          await page.route('**/api/partner/me', (route) => route.fulfill({ json: PARTNER }));
        }
        await setBrowserState(page, { theme, dir });
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPath(page, `/${language}${surface.path}`);
        await surface.ready?.(page);
        await page.waitForLoadState('networkidle');
        await settleAnimations(page);

        // AC-22 at 1280: axe, a focus ring and a 24px target on every focusable.
        await expectNoAxeViolations(page);
        expect(await walkFocus(page), `${tag} ${surface.path} focus and targets at 1280`).toEqual(
          [],
        );

        // AC-14 and AC-22: the page and the theme are the ones asked for.
        await expect(page.locator('html')).toHaveAttribute('dir', dir);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

        // One main action: at most one default or brand variant button on the page.
        expect(
          await page
            .locator('button[data-variant="default"], button[data-variant="brand"]')
            .count(),
          'at most one main action',
        ).toBeLessThanOrEqual(1);

        // The brand: the accent only on the rule, the tile and the main button (AC-19); every
        // other page falls back to the primary.
        const brand = await paintOf(page, '--brand', 'backgroundColor');
        const primary = await paintOf(page, '--primary', 'backgroundColor');
        if (surface.accent) {
          const painted = await paintedWithAccent(page);
          expect(painted, 'the accent shows only where it may').toEqual(surface.accent);

          if (surface.tag === 'brand') {
            const look = await page.getByTestId('brand-button').evaluate((element) => {
              const style = getComputedStyle(element);
              return { image: style.backgroundImage, color: style.backgroundColor };
            });
            expect(look, 'the portal button is the flat accent, no gradient').toEqual({
              image: 'none',
              color: ACCENT,
            });
          }
        } else {
          expect(brand, `${surface.path} falls back to the primary`).toBe(primary);
          expect(await paintedWithAccent(page), 'no accent anywhere').toEqual([]);
        }

        // AC-8: a field is the field fill (the page colour, or the card colour on a card in light).
        if (surface.fields) {
          const result = await measureFields(page, 'main');
          expect(result.fields.length, 'the page has a field').toBeGreaterThan(0);
          expect(
            result.fields
              .filter((field) => {
                const want = !result.dark && field.onCard ? result.cardColor : result.pageColor;
                return field.fill !== want;
              })
              .map((field) => `${field.kind}#${field.id} painted ${field.fill}`),
            'fields use the field fill',
          ).toEqual([]);
        }

        // The partner navigation: the current page tint and 2px mark, a plain header.
        if (surface.partner) {
          const nav = await page.evaluate(() => {
            const header = document.querySelector('header');
            const frame = document.querySelector('[data-slot="partner-frame"]') ?? document.body;
            const links = [...document.querySelectorAll<HTMLElement>('header nav a')];
            return {
              headerFill: header ? getComputedStyle(header).backgroundColor : '',
              pageFill: getComputedStyle(frame).backgroundColor,
              links: links.map((link) => {
                const style = getComputedStyle(link);
                const mark = getComputedStyle(link, '::before');
                return {
                  current: link.getAttribute('aria-current') === 'page',
                  image: style.backgroundImage,
                  markHeight: mark.content === 'none' ? 0 : parseFloat(mark.height),
                  markImage: mark.content === 'none' ? 'none' : mark.backgroundImage,
                };
              }),
            };
          });
          expect(nav.headerFill, 'the header is the page colour').toBe(nav.pageFill);
          expect(nav.links.length, 'the partner navigation').toBeGreaterThan(0);
          for (const link of nav.links) {
            if (link.current) {
              expect(link.image, 'current link has the tint').not.toBe('none');
              expect(link.markHeight, 'current link has a 2px mark').toBe(2);
              expect(link.markImage, 'the mark is the marker gradient').not.toBe('none');
            } else {
              expect(link.image, 'other links have no tint').toBe('none');
              expect(link.markHeight, 'other links have no mark').toBe(0);
            }
          }
        }

        // AC-22 at the portal's 320px baseline: no sideways scroll, axe, targets and focus again.
        await page.setViewportSize({ width: 320, height: 740 });
        await settleAnimations(page);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          `${surface.path} does not scroll sideways at 320px`,
        ).toBe(true);
        await expectNoAxeViolations(page);
        expect(await walkFocus(page), `${tag} ${surface.path} focus and targets at 320`).toEqual(
          [],
        );
      });
    }
  });
}

test('/ar/returns: every font request is same origin and exactly one Arabic file loads', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').host;
  const foreign = new Set<string>();
  const fonts: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.host !== origin) foreign.add(url.host);
    if (request.resourceType() === 'font') fonts.push(url.pathname);
  });
  await stubConfig(page);
  await page.goto('/ar/returns');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');

  expect([...foreign], 'no request leaves the origin, and none reaches a font host').toEqual([]);
  const arabic = await page.evaluate(() =>
    [...document.fonts]
      .filter((face) => face.status === 'loaded' && /Noto Sans Arabic/i.test(face.family))
      .map((face) => face.weight),
  );
  expect(arabic.length, 'one Arabic face is in use').toBe(1);
  // One variable file carries the whole weight pair; every font is a file the app serves itself.
  expect(fonts.filter((file) => /noto_sans_arabic/.test(file))).toHaveLength(1);
  for (const file of fonts) expect(file).toMatch(/^\/_next\/static\/media\/.+\.woff2$/);
});
