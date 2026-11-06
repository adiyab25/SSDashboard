import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSkuListSql } from '../src/catalog/catalog.service.js';
import { ledgerHarness, posting, type LedgerHarness } from './ledger.js';
import { randomScaleKeys, seedScale, SPEC_SCALE, type SeedStep } from './scale-seed.js';

// Spec 0002 "Scale suite": the budgets of the table, p95 over RUNS timed runs after a warm up, on
// the dev PostgreSQL. Every budget is Assumed (spec 0007 section 11), reset from the first
// measured run. Each row also asserts, from EXPLAIN, that the read uses the index the budget row
// names, so a budget can never pass by luck on a small cache.
const BUDGET_SKU_SEARCH_MS = 150;
const BUDGET_STOCK_ON_HAND_MS = 50;
const BUDGET_LEDGER_POST_MS = 50;
const BUDGET_ORDER_BY_NUMBER_MS = 20;
const BUDGET_CUSTOMER_BY_PHONE_MS = 20;
const BUDGET_CREDIT_BALANCE_MS = 20;
const BUDGET_CONFIRMATION_QUEUE_MS = 150;
const BUDGET_ORDERS_LIST_MS = 150;
const BUDGET_ORDERS_OF_DAY_MS = 150;
const BUDGET_MY_WORK_MS = 150;
const BUDGET_UNMATCHED_LINES_MS = 150;
const BUDGET_ORDER_TIMELINE_MS = 50;

const WARMUP = 20;
const RUNS = 60;
const INPUTS = WARMUP + RUNS;

type Pool = DatabaseConnection['pool'];

interface RowResult {
  row: string;
  budgetMs: number;
  p95Ms: number;
  runs: number;
}

/** One SQL read of a budget row: how to explain it and how to run it for the n-th input. */
interface Read {
  label: string;
  indexes: string[];
  explain: (n: number) => Promise<string>;
  run: (n: number) => Promise<unknown>;
}

/** Writes a report line straight to stdout, so a passing run still shows its numbers. */
function report(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Renders rows as an aligned text table. */
function table(rows: object[]): string {
  const cells = rows as Record<string, unknown>[];
  const columns = Object.keys(cells[0] ?? {});
  const width = (column: string) =>
    Math.max(column.length, ...cells.map((row) => String(row[column]).length));
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(width(columns[i] ?? ''))).join('  ');
  return [
    line(columns),
    ...cells.map((row) => line(columns.map((column) => String(row[column])))),
  ].join('\n');
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

/** Runs `run` for inputs `from` to `to - 1` one at a time and returns each duration in ms. */
async function timed(from: number, to: number, run: (n: number) => Promise<unknown>) {
  const samples: number[] = [];
  for (let n = from; n < to; n += 1) {
    const started = performance.now();
    await run(n);
    samples.push(performance.now() - started);
  }
  return samples;
}

/** A read written as SQL text with positional parameters, one parameter list per input. */
function sqlRead(
  pool: Pool,
  label: string,
  indexes: string[],
  text: string,
  inputs: unknown[][],
): Read {
  const values = (n: number): unknown[] => inputs[n % inputs.length] ?? [];
  return {
    label,
    indexes,
    async explain(n) {
      const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) ${text}`,
        values(n),
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    },
    run: (n) => pool.query(text, values(n)),
  };
}

/** Whether a text plan reads `index` with an index scan, an index only scan, or a bitmap scan. */
function planUses(plan: string, index: string): boolean {
  return new RegExp(
    `(Index( Only)? Scan( Backward)? using ${index} on|Bitmap Index Scan on ${index}\\b)`,
  ).test(plan);
}

describe('the data model at scale', { timeout: 3_600_000 }, () => {
  let h: LedgerHarness;
  let seedSteps: SeedStep[] = [];
  let seedSeconds = 0;
  let keys: { variantId: string; locationId: string }[] = [];
  const results: RowResult[] = [];
  const plans: string[] = [];

  async function rows<T extends Record<string, unknown>>(text: string): Promise<T[]> {
    return (await h.owner.pool.query<T>(text)).rows;
  }

  /** Asserts the plan of each read uses its named indexes, then times it and checks the budget. */
  async function checkRow(row: string, budgetMs: number, reads: Read[]): Promise<void> {
    const timings: number[] = [];
    for (const read of reads) {
      const plan = await read.explain(0);
      plans.push(`${row} (${read.label}):
${plan}`);
      for (const index of read.indexes) {
        expect(planUses(plan, index), `${row} (${read.label}) must use ${index}`).toBe(true);
      }
      await timed(0, WARMUP, read.run);
      const samples = await timed(WARMUP, INPUTS, read.run);
      timings.push(p95(samples));
    }
    const worst = Math.max(...timings);
    results.push({ row, budgetMs, p95Ms: Number(worst.toFixed(1)), runs: RUNS });
    expect(worst, `${row} p95 ${worst.toFixed(1)} ms`).toBeLessThan(budgetMs);
  }

  beforeAll(async () => {
    h = await ledgerHarness();
    const started = performance.now();
    seedSteps = await seedScale(h.owner, SPEC_SCALE);
    seedSeconds = (performance.now() - started) / 1000;
    keys = await randomScaleKeys(h.owner, INPUTS);
  }, 3_600_000);

  afterAll(async () => {
    report(`seed: ${seedSeconds.toFixed(1)} s in total`);
    report(
      table(
        seedSteps.map((step) => ({ step: step.name, seconds: Number(step.seconds.toFixed(1)) })),
      ),
    );
    report(`EXPLAIN plans:\n${plans.join('\n\n')}`);
    report(table(results));
    await h?.close();
  });

  it('holds the spec 0002 load', async () => {
    const [counts] = await rows<Record<string, number>>(`
      SELECT (SELECT count(*) FROM products)::int AS styles,
             (SELECT count(*) FROM product_variants)::int AS variants,
             (SELECT count(*) FROM stock_movements)::int AS movements,
             (SELECT count(*) FROM orders)::int AS orders,
             (SELECT count(DISTINCT operating_day) FROM orders)::int AS operating_days,
             (SELECT count(DISTINCT store_id) FROM orders)::int AS stores,
             (SELECT count(*) FROM order_lines)::int AS order_lines,
             (SELECT count(*) FROM order_events)::int AS order_events,
             (SELECT count(*) FROM customers)::int AS customers,
             (SELECT count(*) FROM customers WHERE merged_into_id IS NOT NULL)::int AS merged,
             (SELECT count(*) FROM customer_phones)::int AS phones,
             (SELECT count(*) FROM settlement_lines)::int AS settlement_lines,
             (SELECT count(*) FROM settlement_line_matches)::int AS matches,
             (SELECT count(*) FROM tasks)::int AS tasks,
             (SELECT count(*) FROM tasks WHERE status = 'open')::int AS open_tasks,
             (SELECT count(*) FROM credit_entries)::int AS credit_entries`);
    report(table([counts ?? {}]));

    expect(counts).toMatchObject({
      styles: SPEC_SCALE.styles,
      variants: SPEC_SCALE.styles * SPEC_SCALE.variantsPerStyle,
      movements: SPEC_SCALE.movements,
      orders: SPEC_SCALE.orders,
      stores: 3,
      customers: SPEC_SCALE.customers,
      phones: SPEC_SCALE.phones,
      settlement_lines: SPEC_SCALE.settlementLines,
      matches: SPEC_SCALE.settlementLines,
      tasks: SPEC_SCALE.tasks,
      open_tasks: SPEC_SCALE.openTasks,
      credit_entries: SPEC_SCALE.creditEntries,
    });
    expect(counts?.operating_days).toBeGreaterThanOrEqual(SPEC_SCALE.operatingDays - 2);
    expect(counts?.order_lines).toBeGreaterThan(200_000);
    expect(counts?.order_lines).toBeLessThan(220_000);
    expect(counts?.order_events).toBeGreaterThan(440_000);
    expect(counts?.order_events).toBeLessThan(460_000);
  });

  it('keeps every order total equal to its lines plus shipping', async () => {
    const [bad] = await rows<{ bad: number }>(`
      SELECT count(*)::int AS bad FROM orders o
      WHERE o.lines_gross_amount <> (SELECT sum(gross_amount) FROM order_lines l WHERE l.order_id = o.id)`);

    expect(bad?.bad).toBe(0);
  });

  it(`searches SKUs by code prefix and name fragment (150 ms budget)`, async () => {
    const skus = await rows<{ sku: string }>(
      `SELECT sku FROM product_variants ORDER BY random() LIMIT ${INPUTS}`,
    );
    const search = (label: string, indexes: string[], terms: string[]): Read => ({
      label,
      indexes,
      async explain(n) {
        const { rows: plan } = await h.app.db.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN (COSTS OFF) ${buildSkuListSql({ q: terms[n % terms.length] ?? '', status: 'active', limit: 50 })}`,
        );
        return plan.map((row) => row['QUERY PLAN']).join('\n');
      },
      run: (n) =>
        h.app.db.execute(
          buildSkuListSql({ q: terms[n % terms.length] ?? '', status: 'active', limit: 50 }),
        ),
    });
    const prefixes = skus.map((row) => row.sku.slice(0, 10));
    const fragments = Array.from(
      { length: INPUTS },
      (_, n) => `product ${1 + ((n * 977) % SPEC_SCALE.styles)}`,
    );

    await checkRow('SKU search', BUDGET_SKU_SEARCH_MS, [
      search('code prefix', ['product_variants_sku_c_idx'], prefixes),
      search('name fragment', [], fragments),
    ]);
  });

  it('reads on hand and available for one SKU', async () => {
    const run = (n: number) =>
      h.ledger.getAvailable({ variantId: keys[n % keys.length]?.variantId ?? '' });
    await timed(0, WARMUP, run);
    const value = p95(await timed(WARMUP, INPUTS, run));

    results.push({
      row: 'Stock on hand',
      budgetMs: BUDGET_STOCK_ON_HAND_MS,
      p95Ms: Number(value.toFixed(1)),
      runs: RUNS,
    });
    expect(value).toBeLessThan(BUDGET_STOCK_ON_HAND_MS);
  });

  it('posts a single ledger line', async () => {
    const run = (n: number) => {
      const key = keys[n % keys.length];
      if (!key) throw new Error('no seeded stock balance');
      return h.ledger.post(posting([{ ...key, quantity: 1, unitCost: '2.5000' }]));
    };
    await timed(0, WARMUP, run);
    const value = p95(await timed(WARMUP, INPUTS, run));

    results.push({
      row: 'Ledger post, one line',
      budgetMs: BUDGET_LEDGER_POST_MS,
      p95Ms: Number(value.toFixed(1)),
      runs: RUNS,
    });
    expect(value).toBeLessThan(BUDGET_LEDGER_POST_MS);
  });

  it('finds an order by store and number', async () => {
    const inputs = (
      await rows<{ store_id: string; order_number: string }>(
        `SELECT store_id, order_number FROM orders ORDER BY random() LIMIT ${INPUTS}`,
      )
    ).map((row) => [row.store_id, row.order_number]);

    await checkRow('Order by store and number', BUDGET_ORDER_BY_NUMBER_MS, [
      sqlRead(
        h.app.pool,
        'unique key',
        ['orders_store_number_unique'],
        `SELECT id, fulfillment_state, cash_state, total_amount FROM orders
         WHERE tenant_id = current_setting('ssd.tenant_id')::uuid AND store_id = $1 AND order_number = $2`,
        inputs,
      ),
    ]);
  });

  it('finds a customer by phone', async () => {
    const inputs = (
      await rows<{ phone_e164: string }>(
        `SELECT phone_e164 FROM customer_phones ORDER BY random() LIMIT ${INPUTS}`,
      )
    ).map((row) => [row.phone_e164]);

    await checkRow('Customer by phone', BUDGET_CUSTOMER_BY_PHONE_MS, [
      sqlRead(
        h.app.pool,
        'unique key',
        ['customer_phones_phone_unique'],
        `SELECT c.id, c.name, c.merged_into_id FROM customer_phones p JOIN customers c ON c.id = p.customer_id
         WHERE p.tenant_id = current_setting('ssd.tenant_id')::uuid AND p.phone_e164 = $1`,
        inputs,
      ),
    ]);
  });

  it("sums one customer's credit over the canonical id and the two merged into it", async () => {
    const canonical = await rows<{ id: string }>(
      `SELECT id FROM (SELECT DISTINCT merged_into_id AS id FROM customers WHERE merged_into_id IS NOT NULL) t
       ORDER BY random() LIMIT ${INPUTS}`,
    );
    const [ids] = await rows<{ ids: number }>(
      `SELECT count(*)::int AS ids FROM customers WHERE id = '${canonical[0]?.id}' OR merged_into_id = '${canonical[0]?.id}'`,
    );
    expect(ids?.ids).toBe(3);

    await checkRow('Credit balance, 3 ids', BUDGET_CREDIT_BALANCE_MS, [
      sqlRead(
        h.app.pool,
        'canonical customer',
        ['credit_entries_customer_funding_idx'],
        `SELECT funding, sum(amount) AS balance FROM credit_entries
         WHERE customer_id IN (SELECT $1::uuid UNION ALL SELECT id FROM customers WHERE merged_into_id = $1::uuid)
         GROUP BY funding`,
        canonical.map((row) => [row.id]),
      ),
    ]);
  });

  it('pages the confirmation queue', async () => {
    const cursors = await rows<{ placed_at: string; id: string }>(
      `SELECT placed_at::text, id FROM orders WHERE fulfillment_state = 'new' ORDER BY random() LIMIT ${INPUTS - 1}`,
    );
    const inputs = [
      ['-infinity', '00000000-0000-0000-0000-000000000000'],
      ...cursors.map((row) => [row.placed_at, row.id]),
    ];

    await checkRow('Confirmation queue page', BUDGET_CONFIRMATION_QUEUE_MS, [
      sqlRead(
        h.app.pool,
        'oldest new, 50 rows',
        ['orders_confirmation_queue_idx'],
        `SELECT id, store_id, order_number, placed_at FROM orders
         WHERE fulfillment_state = 'new' AND (placed_at, id) > ($1::timestamptz, $2::uuid)
         ORDER BY placed_at, id LIMIT 50`,
        inputs,
      ),
    ]);
  });

  it("pages one store's orders by keyset", async () => {
    const cursors = await rows<{ store_id: string; placed_at: string; id: string }>(
      `SELECT store_id, placed_at::text, id FROM orders ORDER BY random() LIMIT ${INPUTS}`,
    );
    const inputs = cursors.map((row) => [row.store_id, row.placed_at, row.id]);

    await checkRow('Orders list page by store', BUDGET_ORDERS_LIST_MS, [
      sqlRead(
        h.app.pool,
        'first page',
        ['orders_store_placed_idx'],
        `SELECT id, order_number, placed_at, total_amount FROM orders
         WHERE store_id = $1 ORDER BY placed_at DESC, id DESC LIMIT 50`,
        inputs.map((input) => [input[0]]),
      ),
      sqlRead(
        h.app.pool,
        'next page by keyset',
        ['orders_store_placed_idx'],
        `SELECT id, order_number, placed_at, total_amount FROM orders
         WHERE store_id = $1 AND (placed_at, id) < ($2::timestamptz, $3::uuid)
         ORDER BY placed_at DESC, id DESC LIMIT 50`,
        inputs,
      ),
    ]);
  });

  it("lists one operating day's orders of one store", async () => {
    const inputs = (
      await rows<{ operating_day: string; store_id: string }>(
        `SELECT operating_day::text, store_id FROM orders ORDER BY random() LIMIT ${INPUTS}`,
      )
    ).map((row) => [row.operating_day, row.store_id]);

    await checkRow('Orders of one day per store', BUDGET_ORDERS_OF_DAY_MS, [
      sqlRead(
        h.app.pool,
        'report',
        ['orders_operating_day_store_idx'],
        `SELECT id, order_number, fulfillment_state, total_amount FROM orders
         WHERE operating_day = $1::date AND store_id = $2 ORDER BY placed_at, id`,
        inputs,
      ),
    ]);
  });

  it('pages My work for a person and for a hat', async () => {
    const people = await rows<{ id: string }>(
      `SELECT DISTINCT owner_user_id AS id FROM tasks WHERE status = 'open' AND owner_user_id IS NOT NULL`,
    );
    const hats = await rows<{ hat: string }>(
      `SELECT DISTINCT owner_hat AS hat FROM tasks WHERE status = 'open' AND owner_user_id IS NULL`,
    );
    const repeat = <T>(items: T[]): T[] =>
      Array.from({ length: INPUTS }, (_, n) => items[n % items.length] as T);
    expect(people.length).toBeGreaterThan(0);
    expect(hats.length).toBe(4);

    await checkRow('My work, person and hat', BUDGET_MY_WORK_MS, [
      sqlRead(
        h.app.pool,
        'person',
        ['tasks_open_owner_user_idx'],
        `SELECT id, type, linked_type, linked_id, due_at FROM tasks
         WHERE status = 'open' AND owner_user_id = $1 ORDER BY due_at LIMIT 50`,
        repeat(people).map((row) => [row.id]),
      ),
      sqlRead(
        h.app.pool,
        'hat',
        ['tasks_open_owner_hat_idx'],
        `SELECT id, type, linked_type, linked_id, due_at FROM tasks
         WHERE status = 'open' AND owner_user_id IS NULL AND owner_hat = $1 ORDER BY due_at LIMIT 50`,
        repeat(hats).map((row) => [row.hat]),
      ),
    ]);
  });

  it('lists the unmatched lines of one statement', async () => {
    const inputs = (
      await rows<{ id: string }>(
        `SELECT id FROM settlement_statements ORDER BY random() LIMIT ${INPUTS}`,
      )
    ).map((row) => [row.id]);

    // A line's state is the head of its match chain: the row no other row supersedes; no row at
    // all means unmatched (`lineMatchState`, spec 0002 settlement).
    await checkRow('Unmatched lines of a statement', BUDGET_UNMATCHED_LINES_MS, [
      sqlRead(
        h.app.pool,
        'head match row',
        ['settlement_lines_statement_idx', 'settlement_line_matches_line_recorded_idx'],
        `SELECT l.id, l.external_line_ref, l.amount, h.result, h.reason_code
         FROM settlement_lines l
         LEFT JOIN LATERAL (
           SELECT m.result, m.reason_code FROM settlement_line_matches m
           WHERE m.line_id = l.id
             AND NOT EXISTS (SELECT 1 FROM settlement_line_matches s WHERE s.supersedes_match_id = m.id)
         ) h ON true
         WHERE l.statement_id = $1 AND (h.result IS NULL OR h.result = 'unmatched')
         ORDER BY l.id LIMIT 50`,
        inputs,
      ),
    ]);
  });

  it("reads one order's event timeline", async () => {
    const inputs = (
      await rows<{ id: string }>(`SELECT id FROM orders ORDER BY random() LIMIT ${INPUTS}`)
    ).map((row) => [row.id]);

    await checkRow('Order event timeline', BUDGET_ORDER_TIMELINE_MS, [
      sqlRead(
        h.app.pool,
        'replay order',
        ['order_events_order_recorded_idx'],
        `SELECT id, machine, from_state, to_state, actor_type, occurred_at FROM order_events
         WHERE order_id = $1 ORDER BY recorded_at, id`,
        inputs,
      ),
    ]);
  });

  it.todo('audit trail at 5,000,000 entries (spec 0010 AC-17): feature 10 adds audit_entries');
});
