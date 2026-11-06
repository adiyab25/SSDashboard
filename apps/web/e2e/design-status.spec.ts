import { expect, test } from '@playwright/test';
import { openShell } from './support';

// Spec 0003 (amendment): status components and the floor density scope on /design.
test.describe('/design status samples (AC-16, AC-17, AC-22)', () => {
  test('every status chip has an icon and a word', async ({ page }) => {
    await openShell(page, '/design');

    const chips = page.locator('[data-slot="status-chip"]');
    expect(await chips.count()).toBeGreaterThan(0);
    for (const chip of await chips.all()) {
      await expect(chip.locator('svg')).toHaveCount(1);
      expect(((await chip.textContent()) ?? '').trim()).not.toBe('');
    }
  });

  test('the queue outcome buttons are 48px on a coarse pointer and 40px tall on a mouse', async ({
    page,
  }, info) => {
    await openShell(page, '/design');

    const group = page
      .getByTestId('confirmation-queue-card')
      .getByRole('group', { name: 'Outcome' });
    // Locators, not element handles from `.all()`: the gallery remounts once after the shell
    // finishes loading, which detaches handles taken before it ("Element is not attached").
    await expect(group.getByRole('button')).toHaveCount(4);
    // toPass retries the whole measurement if the remount lands mid action.
    await expect(async () => {
      for (let index = 0; index < 4; index += 1) {
        const button = group.getByRole('button').nth(index);
        await button.scrollIntoViewIfNeeded({ timeout: 2_000 });
        const box = await button.boundingBox();
        if (info.project.name === 'mobile') {
          expect(box?.width).toBeGreaterThanOrEqual(48);
          expect(box?.height).toBeGreaterThanOrEqual(48);
        } else {
          expect(box?.height).toBe(40);
        }
      }
    }).toPass({ timeout: 15_000 });
  });
});
