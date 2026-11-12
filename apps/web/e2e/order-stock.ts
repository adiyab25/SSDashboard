import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Locator } from '@playwright/test';
import { en } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { api, createLocation, receive } from './master-data-api';
import type { TextDirection } from './support';

/**
 * Helpers of the orders specs that need stock held (spec 0013 AC-13, AC-26). Since milestone 4 a
 * pack answers 409 `LINE_SHORT` unless every open line is held in full at the online location, so
 * a test that packs first makes a fresh warehouse with stock the one online location, through the
 * real api and its gate. The flag is shared state: the caller holds `acquireOnlineFlag` from
 * `online-flag.ts` for the whole test and stops online stock in its cleanup.
 */

/** The online gate's answer, as far as these helpers read it. */
interface GateAnswer {
  variantsWithStock: number;
}

/**
 * Makes a new warehouse holding `quantity` pieces of each SKU the one online location: receives
 * the stock, confirms it counted, holds the install's open orders there (the
 * `orders.open_orders_held` check), and moves the flag with the count the gate shows. An order
 * placed in parallel between the hold and the move fails the gate, so that pair runs again, a few
 * times at most. Its code sorts last, out of the way of the gate specs' rows. `request` needs `catalog.manage` and `stock.receive`. Answers the location id.
 */
export async function stockedOnline(
  request: APIRequestContext,
  skuIds: readonly string[],
  quantity = 50,
): Promise<string> {
  const location = await createLocation(request, `ZOS${randomUUID().slice(0, 6).toUpperCase()}`);
  for (const skuId of skuIds) await receive(request, location.id, skuId, quantity);
  const confirmed = await api(request, 'POST', `/locations/${location.id}/confirm-stock`, {});
  expect([200, 201], JSON.stringify(confirmed.body)).toContain(confirmed.status);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const held = await api(request, 'POST', '/orders/hold-open-orders', {
      locationId: location.id,
    });
    expect([200, 201], JSON.stringify(held.body)).toContain(held.status);
    const gate = await api(request, 'GET', `/locations/${location.id}/online-gate`);
    expect(gate.status, JSON.stringify(gate.body)).toBe(200);
    const moved = await api(request, 'POST', `/locations/${location.id}/make-online`, {
      confirmedVariantCount: (gate.body as unknown as GateAnswer).variantsWithStock,
      reason: 'e2e orders stock',
    });
    if (moved.status === 200 || moved.status === 201) return location.id;
    const code = String(moved.body.code);
    expect(['ONLINE_GATE_FAILED', 'ONLINE_GATE_STALE'], JSON.stringify(moved.body)).toContain(code);
  }
  throw new Error('The orders warehouse could not be moved online after 5 tries');
}

/** The words of the online gate's orders check a real gate test needs. */
export interface HoldWords {
  /** The button label `orders.onlineGate.holdOpenOrders`. */
  hold: string;
  /** The result title `orders.onlineGate.heldTitle`. */
  heldTitle: string;
}

/**
 * On the real online gate, runs "Hold the open orders here" when the `orders.open_orders_held`
 * check fails (other specs leave open orders in the shared database, so it may or may not), waits
 * for the counts it answers and the gate's re read, and ends when the button is gone (the check
 * passes). Specs in parallel workers keep placing orders, which a check counts as not held, so it
 * runs again a few times at most. `press` presses a button the way the calling test drives the
 * dialog (keyboard or touch) and must give up within seconds when the button goes away.
 */
export async function holdOpenOrdersIfAsked(
  dialog: Locator,
  words: HoldWords,
  press: (button: Locator) => Promise<void>,
): Promise<void> {
  const hold = dialog.getByRole('button', { name: words.hold });
  for (let attempt = 0; attempt < 4 && (await hold.isVisible()); attempt += 1) {
    // The dialog reads the gate again once the hold answered; wait for that read.
    const reread = dialog
      .page()
      .waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname.endsWith('/online-gate'),
        { timeout: 45_000 },
      )
      .catch(() => null);
    try {
      await press(hold);
    } catch {
      // The button went away under the press (a re read already passed the check): look again.
      continue;
    }
    // The hold reads every open order of the shared database (about 12 ms per order on an idle
    // machine, 2.4 s for 200; QA 2026-11-12), so under a full parallel run it outlasts the 5 s
    // default; the button stays disabled until it answers.
    await expect(dialog.getByRole('status', { name: words.heldTitle })).toBeVisible({
      timeout: 30_000,
    });
    await reread;
  }
  await expect(hold).toHaveCount(0);
}

/**
 * Presses the gate's move button until the dialog closes: when an order placed by a parallel spec
 * failed the orders check between the hold and the move (409 `ONLINE_GATE_FAILED`, the dialog
 * reads the gate again and stays open), holds the open orders again and presses once more, a few
 * times at most. The reason must already be typed.
 */
export async function moveOnlineHoldingOrders(
  dialog: Locator,
  move: Locator,
  words: HoldWords,
  press: (button: Locator) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await holdOpenOrdersIfAsked(dialog, words, press);
    await expect(move).toBeEnabled();
    await press(move);
    const closed = await expect(dialog)
      .toBeHidden({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    if (closed) return;
  }
  await expect(dialog).toBeHidden();
}

/**
 * The "short by" mark of an order line in the language a direction opens in, for `count` pieces.
 * `MessageKey` (and so `textFor`) leaves plural forms out, so this reads the plural entry itself:
 * Arabic has its own form for two pieces, English one form above one.
 */
export function shortByText(dir: TextDirection, count: number): string {
  const lines: unknown = (dir === 'rtl' ? ar : en).orders;
  const forms = (lines as { lines: Record<string, unknown> }).lines;
  const form =
    dir === 'rtl'
      ? count === 1
        ? 'short_one'
        : count === 2
          ? 'short_two'
          : 'short_other'
      : count === 1
        ? 'short_one'
        : 'short_other';
  const text = forms[form];
  if (typeof text !== 'string') throw new Error(`No catalog text for orders.lines.${form}`);
  return text.replace('{{count}}', String(count));
}
