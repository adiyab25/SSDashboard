import { expect, test } from '@playwright/test';
import { stubConfig } from './support';

// Spec 0003 AC-19: a brand accent colours only the logo tile, a top rule, and the main portal
// button. This walks every element of the sample portal page and lists what is painted in the
// accent in any colour property, in both languages, so a fourth use shows up here.
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 800 } });

const ACCENT = 'rgb(10, 124, 57)';

for (const language of ['en', 'ar']) {
  test(`/${language}/returns/preview/brand: the accent shows on exactly the tile, the top rule, and the main button`, async ({
    page,
  }) => {
    await stubConfig(page);
    await page.goto(`/${language}/returns/preview/brand`);
    await page.waitForLoadState('networkidle');

    const painted = await page.evaluate((accent) => {
      const found: string[] = [];
      for (const element of document.querySelectorAll('body *')) {
        const style = getComputedStyle(element);
        const props = [
          style.backgroundColor,
          style.color,
          style.borderTopColor,
          style.borderBottomColor,
          style.borderInlineStartColor,
          style.borderInlineEndColor,
          style.outlineColor,
          style.fill,
          style.stroke,
        ];
        const showsBorder = ['Top', 'Bottom', 'Left', 'Right'].some(
          (side) => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
        );
        const outlines = parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none';
        const hit = props.some((value, index) => {
          if (value !== accent) return false;
          if (index === 0) return true;
          if (index >= 2 && index <= 5) return showsBorder;
          if (index === 6) return outlines;
          return index === 1 || index >= 7;
        });
        if (hit) {
          const slot = element.getAttribute('data-slot') ?? element.getAttribute('data-testid');
          found.push(`${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}`);
        }
      }
      return found;
    }, ACCENT);

    // The top rule (a div), the logo tile (an img), and the main button: nothing else, and no text.
    expect(painted).toEqual(['div', 'img', 'button[button]']);
  });
}
