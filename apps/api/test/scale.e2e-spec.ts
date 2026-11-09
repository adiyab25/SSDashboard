import { randomUUID } from 'node:crypto';
import { AuditEntryListQuery, personActor, type SkuListQuery } from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditQueryService } from '../src/audit/audit-query.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { buildSkuListSql, searchWords } from '../src/catalog/search/sku-list-sql.js';
import { StaffDirectory } from '../src/identity/staff/staff-directory.js';
import { buildAvailabilitySql } from '../src/inventory/ledger/ledger.service.js';
import { encodeKeyset } from '../src/platform/keyset-cursor.js';
import { ledgerHarness, posting, type LedgerHarness } from './ledger.js';
import { auditActionSpread, AUDIT_SCALE, seedAuditScale } from './scale-audit-seed.js';
import {
  GARMENTS,
  MODEL_NAMES,
  modelName,
  randomScaleKeys,
  SCALE_SEASONS,
  seedScale,
  SPEC_SCALE,
  STYLE_WORDS,
  type SeedStep,
} from './scale-seed.js';

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
// Spec 0010 AC-17, also Assumed and reset from the first measured run.
const BUDGET_AUDIT_PAGE_MS = 150;
const BUDGET_AUDIT_RECORD_MS = 10;

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

/**
 * One SQL read of a budget row: how to explain it and how to run it for the n-th input. The plan
 * must use every index in `indexes`, and at least one of `anyOf` when it is given (a filter the
 * planner may serve from either of two indexes, by how common the value is), and its text must
 * match `shows` when it is given (a condition the plan must carry).
 */
interface Read {
  label: string;
  indexes: string[];
  anyOf?: string[];
  shows?: RegExp;
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
      if (read.shows) {
        expect(plan, `${row} (${read.label}) must show ${String(read.shows)}`).toMatch(read.shows);
      }
      if (read.anyOf) {
        expect(
          read.anyOf.some((index) => planUses(plan, index)),
          `${row} (${read.label}) must use one of ${read.anyOf.join(', ')}`,
        ).toBe(true);
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
    seedSteps.push(...(await seedAuditScale(h.owner, AUDIT_SCALE)));
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

  // Review R2: the orders child (`lines_gross_amount`) sums the lines that are not cancelled; a
  // wholly cancelled order has 0. The database's own check ties the total to lines plus shipping.
  it('keeps every order line total equal to the sum of its lines that are not cancelled', async () => {
    const [bad] = await rows<{ bad: number; cancelled: number }>(`
      SELECT count(*) FILTER (WHERE o.lines_gross_amount <> coalesce(
               (SELECT sum(gross_amount) FROM order_lines l
                 WHERE l.order_id = o.id AND l.line_state <> 'cancelled'), 0))::int AS bad,
             count(*) FILTER (WHERE o.fulfillment_state = 'cancelled')::int AS cancelled
      FROM orders o`);

    expect(bad?.bad).toBe(0);
    expect(bad?.cancelled).toBeGreaterThan(0);
  });

  // Spec 0012 AC-5: the six SKU searches, each its own budget row, through the same two
  // statements `CatalogService.list` runs (the words from `ssd_search_normalize`, then the
  // three branch union). Every input has a word of 3 or more characters, so every plan holds all
  // three branches: barcode on `barcodes_code_unique`, prefix on `product_variants_sku_c_idx`,
  // contains on `product_variants_search_trgm_idx`.
  describe('SKU search (spec 0012, AC-5, 150 ms budget)', () => {
    const BRANCH_INDEXES = [
      'barcodes_code_unique',
      'product_variants_sku_c_idx',
      'product_variants_search_trgm_idx',
    ];
    const withoutHamza = (text: string) => text.replace(/[أإآ]/g, 'ا').toLowerCase();

    function search(label: string, queries: SkuListQuery[]): Read {
      const queryOf = (n: number): SkuListQuery =>
        queries[n % queries.length] ?? { status: 'active', limit: 50 };
      const statement = async (n: number) => {
        const query = queryOf(n);
        return buildSkuListSql(query, query.q ? await searchWords(h.app.db, query.q) : []);
      };
      return {
        label,
        indexes: BRANCH_INDEXES,
        async explain(n) {
          const { rows: plan } = await h.app.db.execute<{ 'QUERY PLAN': string }>(
            sql`EXPLAIN (COSTS OFF) ${await statement(n)}`,
          );
          return plan.map((row) => row['QUERY PLAN']).join('\n');
        },
        run: async (n) => h.app.db.execute(await statement(n)),
      };
    }

    const term = (q: string, more: Partial<SkuListQuery> = {}): SkuListQuery => ({
      q,
      status: 'active',
      limit: 50,
      ...more,
    });

    it('seeds every style in both languages and every variant with a size, a color, a barcode, and its search text', async () => {
      const [counts] = await rows<Record<string, number>>(`
        SELECT (SELECT count(*) FROM products
                 WHERE style_code LIKE 'SCALE-STYLE-%'
                   AND (name->>'en' IS NULL OR name->>'ar' IS NULL))::int AS unnamed,
               (SELECT count(*) FROM product_variants v
                 WHERE v.sku LIKE 'SCALE-%' AND (SELECT count(*) FROM product_options o
                   WHERE o.product_id = v.product_id
                     AND o.values -> ((v.option_values ->> o.position::text)::int) IS NOT NULL) <> 2
               )::int AS without_size_and_color,
               (SELECT count(*) FROM product_variants v
                 WHERE v.sku LIKE 'SCALE-%'
                   AND (SELECT count(*) FROM barcodes b WHERE b.variant_id = v.id) <> 1)::int
                 AS without_one_barcode,
               (SELECT count(*) FROM product_variants
                 WHERE search_text IS DISTINCT FROM
                       ssd_variant_search_text(product_id, sku, option_values))::int AS drifted`);
      expect(counts).toEqual({
        unnamed: 0,
        without_size_and_color: 0,
        without_one_barcode: 0,
        drifted: 0,
      });
    });

    it('by code prefix', async () => {
      const skus = await rows<{ sku: string }>(
        `SELECT sku FROM product_variants ORDER BY random() LIMIT ${INPUTS}`,
      );
      await checkRow('SKU search: code prefix', BUDGET_SKU_SEARCH_MS, [
        search(
          'code prefix',
          skus.map((row) => term(row.sku.slice(0, 10))),
        ),
      ]);
    });

    it('by an English name fragment', async () => {
      // The first 5 of a model name's 6 letters ("karim" of "Karimo"), about 100 variants each.
      const fragments = Array.from({ length: INPUTS }, (_, n) =>
        modelName((n * 37) % MODEL_NAMES).en.slice(0, 5),
      );
      await checkRow('SKU search: English name fragment', BUDGET_SKU_SEARCH_MS, [
        search(
          'English fragment',
          fragments.map((fragment) => term(fragment)),
        ),
      ]);
    });

    it('by an Arabic fragment typed without hamza', async () => {
      // Arabic model names that carry a hamza, typed without it.
      const fragments = Array.from({ length: MODEL_NAMES }, (_, m) => modelName(m).ar)
        .filter((name) => /[أإآ]/.test(name))
        .filter((_, n) => n % 7 === 0)
        .map(withoutHamza);
      await checkRow('SKU search: Arabic fragment without hamza', BUDGET_SKU_SEARCH_MS, [
        search(
          'Arabic fragment',
          fragments.map((fragment) => term(fragment)),
        ),
      ]);
    });

    it('by two words', async () => {
      const pairs = Array.from({ length: INPUTS }, (_, n) => {
        const word = STYLE_WORDS[(n * 7) % STYLE_WORDS.length]?.en ?? '';
        const garment = GARMENTS[(n * 3) % GARMENTS.length]?.en ?? '';
        return term(`${garment} ${word}`.toLowerCase());
      });
      await checkRow('SKU search: two words', BUDGET_SKU_SEARCH_MS, [search('two words', pairs)]);
    });

    it('by an exact barcode', async () => {
      const codes = await rows<{ code: string }>(
        `SELECT code FROM barcodes ORDER BY random() LIMIT ${INPUTS}`,
      );
      await checkRow('SKU search: exact barcode', BUDGET_SKU_SEARCH_MS, [
        search(
          'barcode',
          codes.map((row) => term(row.code)),
        ),
      ]);
    });

    it('by a fragment with a season filter', async () => {
      const seasons = await rows<{ id: string }>(
        `SELECT id FROM seasons WHERE code LIKE 'SCALE-S%' ORDER BY code`,
      );
      expect(seasons).toHaveLength(SCALE_SEASONS);
      const inputs = Array.from({ length: INPUTS }, (_, n) =>
        term((GARMENTS[n % GARMENTS.length]?.en ?? '').toLowerCase(), {
          seasonId: seasons[n % seasons.length]?.id,
        }),
      );
      await checkRow('SKU search: fragment with season filter', BUDGET_SKU_SEARCH_MS, [
        search('fragment and season', inputs),
      ]);
    });
  });

  // Review R3: the plan of the exact statement getAvailable runs (buildAvailabilitySql) is checked
  // too, so this budget cannot pass on a scan of a small cache.
  it('reads on hand and available for one SKU', async () => {
    const variantOf = (n: number) => keys[n % keys.length]?.variantId ?? '';

    await checkRow('Stock on hand', BUDGET_STOCK_ON_HAND_MS, [
      {
        label: 'getAvailable',
        indexes: ['stock_levels_key_unique'],
        async explain(n) {
          const { rows: plan } = await h.app.db.execute<{ 'QUERY PLAN': string }>(
            sql`EXPLAIN (COSTS OFF) ${buildAvailabilitySql(null, variantOf(n))}`,
          );
          return plan.map((row) => row['QUERY PLAN']).join('\n');
        },
        run: (n) => h.ledger.getAvailable({ variantId: variantOf(n) }),
      },
    ]);
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
        // Review R3: both halves of the three id lookup, the merged customers and their entries.
        ['credit_entries_customer_funding_idx', 'customers_merged_into_idx'],
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

  describe('the audit trail at 5,000,000 entries (spec 0010 AC-17)', () => {
    // The reads go through the real AuditQueryService.list (the page, the undone lookup, and the
    // staff names), as the app role. Its connection records the statements the service issues,
    // so each plan check explains exactly the SQL the service ran, never a copy of it.
    let issued: SQL[] | null = null;
    let query: AuditQueryService;
    const viewer = { has: () => true };

    beforeAll(() => {
      const execute: Database['execute'] = (statement) => {
        if (issued && typeof statement !== 'string') issued.push(statement.getSQL());
        return h.app.db.execute(statement);
      };
      const db = Object.assign(Object.create(h.app.db) as Database, { execute });
      query = new AuditQueryService({ ...h.app, db }, new StaffDirectory(h.app));
    });

    async function explainSql(statement: SQL): Promise<string> {
      const { rows: plan } = await h.app.db.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN (COSTS OFF) ${statement}`,
      );
      return plan.map((row) => row['QUERY PLAN']).join('\n');
    }

    /** A list read: one parsed list query per input, timed through `AuditQueryService.list`. */
    function listRead(
      label: string,
      indexes: string[],
      inputs: Record<string, unknown>[],
      anyOf?: string[],
    ): Read {
      const queries = inputs.map((input) => AuditEntryListQuery.parse(input));
      const at = (n: number) => {
        const picked = queries[n % queries.length];
        if (!picked) throw new Error(`${label}: no inputs`);
        return picked;
      };
      return {
        label,
        indexes,
        anyOf,
        async explain(n) {
          const statements: SQL[] = [];
          issued = statements;
          try {
            await query.list(at(n), viewer);
          } finally {
            issued = null;
          }
          // The page and the undone lookup; the staff names are identity's query.
          return (await Promise.all(statements.map(explainSql))).join('\n--\n');
        },
        run: (n) => query.list(at(n), viewer),
      };
    }

    const repeat = <T>(items: T[]): T[] =>
      Array.from({ length: INPUTS }, (_, n) => items[n % items.length] as T);

    /** A uniform sample of entries, for record, correlation, and cursor inputs. */
    async function sampleEntries() {
      return rows<{
        record_type: string;
        record_id: string;
        correlation_id: string;
        at: string;
        id: string;
      }>(
        `SELECT record_type, record_id, correlation_id, id,
                to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM audit_entries TABLESAMPLE BERNOULLI (0.05) ORDER BY random() LIMIT ${INPUTS}`,
      );
    }

    it('holds the audit load', async () => {
      const [counts] = await rows<Record<string, number | string>>(`
        SELECT (SELECT count(*) FROM audit_entries)::int AS entries,
               (SELECT count(DISTINCT operating_day) FROM audit_entries)::int AS operating_days,
               (SELECT count(DISTINCT actor_user_id) FROM audit_entries)::int AS people,
               (SELECT count(DISTINCT action) FROM audit_entries)::int AS actions,
               (SELECT count(DISTINCT correlation_id) FROM audit_entries)::int AS correlations,
               (SELECT count(*) FROM (SELECT DISTINCT record_type, record_id FROM audit_entries) r)::int AS records,
               pg_size_pretty(pg_total_relation_size('audit_entries')) AS total_size`);
      report(table([counts ?? {}]));
      report(
        table(
          await rows(
            `SELECT actor_kind, count(*)::int AS entries FROM audit_entries GROUP BY 1 ORDER BY 2 DESC`,
          ),
        ),
      );
      report(
        table(
          await rows(
            `SELECT action, record_type, count(*)::int AS entries FROM audit_entries
             GROUP BY 1, 2 ORDER BY 3 DESC`,
          ),
        ),
      );
      const [triggers] = await rows<{ disabled: number }>(
        `SELECT count(*)::int AS disabled FROM pg_trigger
         WHERE tgrelid = 'audit_entries'::regclass AND NOT tgisinternal AND tgenabled = 'D'`,
      );

      expect(counts).toMatchObject({
        entries: AUDIT_SCALE.entries,
        people: AUDIT_SCALE.people,
        actions: auditActionSpread().length,
      });
      expect(counts?.operating_days).toBeGreaterThanOrEqual(AUDIT_SCALE.operatingDays - 2);
      // Both stamp triggers are back on after the seed.
      expect(triggers?.disabled).toBe(0);
    });

    it(`pages the unfiltered list (${BUDGET_AUDIT_PAGE_MS} ms budget)`, async () => {
      const cursors = (await sampleEntries()).map((row) => ({
        cursor: encodeKeyset([row.at, row.id]),
      }));

      await checkRow('Audit page, unfiltered', BUDGET_AUDIT_PAGE_MS, [
        listRead(
          'first page',
          ['audit_entries_recorded_idx', 'audit_entries_undoes_entry_unique'],
          [{}],
        ),
        listRead('next page by keyset', ['audit_entries_recorded_idx'], cursors),
      ]);
    });

    it(`pages one person's entries (${BUDGET_AUDIT_PAGE_MS} ms budget)`, async () => {
      const people = await rows<{ id: string }>(
        `SELECT id FROM users WHERE email LIKE 'scale-auditor-%' ORDER BY random()`,
      );

      await checkRow('Audit page by person', BUDGET_AUDIT_PAGE_MS, [
        listRead(
          'person',
          ['audit_entries_actor_recorded_idx'],
          repeat(people).map((row) => ({ actorUserId: row.id })),
        ),
      ]);
    });

    it(`pages one record's entries (${BUDGET_AUDIT_PAGE_MS} ms budget)`, async () => {
      const sample = await sampleEntries();

      await checkRow('Audit page by record', BUDGET_AUDIT_PAGE_MS, [
        listRead(
          'record type and id',
          ['audit_entries_record_recorded_idx'],
          sample.map((row) => ({ recordType: row.record_type, recordId: row.record_id })),
        ),
      ]);
    });

    // Review AR12: a record type alone (no record id). The record index leads with type then id,
    // so it cannot give this filter its order; a common type is served by the newest first index
    // and a rare one by the record index and a sort. Every seeded type is measured, rarest too.
    it(`pages one record type's entries (${BUDGET_AUDIT_PAGE_MS} ms budget)`, async () => {
      const types = await rows<{ record_type: string; entries: number }>(
        `SELECT record_type, count(*)::int AS entries FROM audit_entries GROUP BY 1 ORDER BY 2 DESC`,
      );

      await checkRow(
        'Audit page by record type',
        BUDGET_AUDIT_PAGE_MS,
        types.map((type) =>
          listRead(
            `${type.record_type}, ${type.entries} entries`,
            [],
            [{ recordType: type.record_type }],
            ['audit_entries_recorded_idx', 'audit_entries_record_recorded_idx'],
          ),
        ),
      );
    });

    it(`pages one action's entries (${BUDGET_AUDIT_PAGE_MS} ms budget)`, async () => {
      const actions = await rows<{ action: string; entries: number }>(
        `SELECT action, count(*)::int AS entries FROM audit_entries GROUP BY 1 ORDER BY 2 DESC`,
      );
      const common = actions[0];
      const rare = actions.at(-1);
      if (!common || !rare) throw new Error('no seeded actions');

      // A code on most entries is cheapest through the newest first index with a filter (the
      // first 50 rows are nearly all its own), so its plan may take either index; a rare code
      // must use the action index, or the page would walk past most of the table.
      const either = ['audit_entries_action_recorded_idx', 'audit_entries_recorded_idx'];
      await checkRow('Audit page by action', BUDGET_AUDIT_PAGE_MS, [
        listRead(`most common, ${common.action}`, [], [{ action: common.action }], either),
        listRead(
          `rarest, ${rare.action}`,
          ['audit_entries_action_recorded_idx'],
          [{ action: rare.action }],
        ),
        listRead(
          'every action in turn',
          [],
          repeat(actions).map((row) => ({ action: row.action })),
          either,
        ),
      ]);
    });

    it(`pages an operating day range (${BUDGET_AUDIT_PAGE_MS} ms budget)`, async () => {
      const days = await rows<{ day: string }>(
        `SELECT d::date::text AS day
         FROM generate_series((SELECT min(operating_day) FROM audit_entries),
                              (SELECT max(operating_day) FROM audit_entries) - 31,
                              interval '1 day') d
         ORDER BY random() LIMIT ${INPUTS}`,
      );
      const [first] = await rows<{ day: string }>(
        `SELECT min(operating_day)::text AS day FROM audit_entries`,
      );
      const oldest = first?.day ?? '';
      // Spec 0010 task 18: the day filter also bounds `recorded_at` (`filtersOf`), so the plan
      // reads the BRIN index, the newest first index from that instant, or both, never the
      // newest first index with only a filter (which walked most of the table for an old day).
      const dayRead = (label: string, inputs: Record<string, unknown>[]): Read => ({
        ...listRead(label, [], inputs, [
          'audit_entries_operating_day_brin',
          'audit_entries_recorded_idx',
        ]),
        shows:
          /Index Cond: \(+recorded_at >= |Bitmap Index Scan on audit_entries_operating_day_brin/,
      });
      const range = (width: number) =>
        days.map((row) => {
          const to = new Date(`${row.day}T00:00:00Z`);
          to.setUTCDate(to.getUTCDate() + width - 1);
          return { dayFrom: row.day, dayTo: to.toISOString().slice(0, 10) };
        });

      await checkRow('Audit page by day range', BUDGET_AUDIT_PAGE_MS, [
        dayRead('one day', range(1)),
        dayRead('seven days', range(7)),
        dayRead('thirty one days', range(31)),
        dayRead('one day, the oldest', [{ dayFrom: oldest, dayTo: oldest }]),
      ]);
    });

    it(`pages one correlation (${BUDGET_AUDIT_PAGE_MS} ms budget)`, async () => {
      const sample = await sampleEntries();

      await checkRow('Audit page by correlation', BUDGET_AUDIT_PAGE_MS, [
        listRead(
          'correlation id',
          ['audit_entries_correlation_idx'],
          sample.map((row) => ({ correlationId: row.correlation_id })),
        ),
      ]);
    });

    // AC-17: one `record` call through the real AuditService, timed inside the caller's
    // transaction (the BEGIN before it and the COMMIT after it are the caller's, not the call's).
    it(`records one entry (${BUDGET_AUDIT_RECORD_MS} ms budget)`, async () => {
      const audit = new AuditService();
      const [person] = await rows<{ id: string }>(
        `SELECT id FROM users WHERE email LIKE 'scale-auditor-%' ORDER BY email LIMIT 1`,
      );
      if (!person) throw new Error('no seeded person');
      const sample = async (): Promise<number> => {
        let ms = Number.POSITIVE_INFINITY;
        await h.app.db.transaction(async (tx) => {
          const started = performance.now();
          await audit.record(tx, {
            actor: personActor(person.id, 'manager'),
            action: 'location.archived',
            record: { type: 'location', id: randomUUID() },
            before: { status: 'active' },
            after: { status: 'archived' },
            reason: 'Scale check',
            correlationId: audit.newCorrelationId(),
          });
          ms = performance.now() - started;
        });
        return ms;
      };
      for (let n = 0; n < WARMUP; n += 1) await sample();
      const samples: number[] = [];
      for (let n = 0; n < RUNS; n += 1) samples.push(await sample());
      const value = p95(samples);

      results.push({
        row: 'Audit record, one entry',
        budgetMs: BUDGET_AUDIT_RECORD_MS,
        p95Ms: Number(value.toFixed(1)),
        runs: RUNS,
      });
      expect(value).toBeLessThan(BUDGET_AUDIT_RECORD_MS);
    });
  });
});
