import type { DatabaseConnection } from '@ssdashboard/db';

// Simplifications of this seed (it loads volume and valid shapes, not a replayable history):
// - Order events are fulfillment events only, three per order (one for `new` orders); no cash
//   machine events are seeded.
// - Credit entries use three kinds only: `opening_balance`, `goodwill`, `order_consumption`.
// - Every order has one line, and two lines on two orders in five; states follow the day offset
//   and `n % 10`.

/**
 * How much data the scale seed loads. `orders` must divide by 3 (three stores) and `movements`
 * by 10 (ten movements per group); `openTasks` is the part of `tasks` still open.
 */
export interface ScaleSeed {
  styles: number;
  variantsPerStyle: number;
  locations: number;
  movements: number;
  orders: number;
  operatingDays: number;
  customers: number;
  phones: number;
  statements: number;
  settlementLines: number;
  tasks: number;
  openTasks: number;
  creditEntries: number;
}

/**
 * The load of spec 0002 "Scale suite": 5,000 styles with 50,000 variants, 500,000 movements,
 * 150,000 orders over 1,095 operating days, 120,000 customers with 150,000 phones, 300,000
 * settlement lines with one match row each, 150,000 tasks (5,000 open), and 20,000 credit entries.
 */
export const SPEC_SCALE: ScaleSeed = {
  styles: 5_000,
  variantsPerStyle: 10,
  locations: 20,
  movements: 500_000,
  orders: 150_000,
  operatingDays: 1_095,
  customers: 120_000,
  phones: 150_000,
  statements: 600,
  settlementLines: 300_000,
  tasks: 150_000,
  openTasks: 5_000,
  creditEntries: 20_000,
};

/** The seasons styles are spread over; style `g` is in season `g % 9`, none when that is 0. */
export const SCALE_SEASONS = 8;

/** The barcode of a seeded variant: `622` and its SKU number, 13 digits (spec 0012, AC-5). */
export const SCALE_BARCODE_SQL = `'622' || lpad(substr(v.sku, 7), 10, '0')`;

/** The first word of a seeded style name, in English and Arabic (25 of them). */
export const STYLE_WORDS: readonly { en: string; ar: string }[] = [
  { en: 'Classic', ar: 'كلاسيك' },
  { en: 'Linen', ar: 'كتان' },
  { en: 'Oversized', ar: 'أوفرسايز' },
  { en: 'Cropped', ar: 'قصير' },
  { en: 'Relaxed', ar: 'مريح' },
  { en: 'Slim', ar: 'ضيق' },
  { en: 'Basic', ar: 'أساسي' },
  { en: 'Printed', ar: 'مطبوع' },
  { en: 'Striped', ar: 'مقلم' },
  { en: 'Washed', ar: 'مغسول' },
  { en: 'Cotton', ar: 'قطن' },
  { en: 'Wool', ar: 'صوف' },
  { en: 'Knit', ar: 'تريكو' },
  { en: 'Denim', ar: 'دنيم' },
  { en: 'Satin', ar: 'ساتان' },
  { en: 'Velvet', ar: 'قطيفة' },
  { en: 'Pleated', ar: 'بليسيه' },
  { en: 'Ribbed', ar: 'مضلع' },
  { en: 'Embroidered', ar: 'مطرز' },
  { en: 'Hooded', ar: 'بكابيشون' },
  { en: 'Long', ar: 'طويل' },
  { en: 'Wide', ar: 'واسع' },
  { en: 'Soft', ar: 'ناعم' },
  { en: 'Light', ar: 'خفيف' },
  { en: 'Summer', ar: 'صيفي' },
];

/** The garment of a seeded style name, in English and Arabic (20 of them). */
export const GARMENTS: readonly { en: string; ar: string }[] = [
  { en: 'Tee', ar: 'تيشيرت' },
  { en: 'Shirt', ar: 'قميص' },
  { en: 'Hoodie', ar: 'هودي' },
  { en: 'Jacket', ar: 'جاكيت' },
  { en: 'Dress', ar: 'فستان' },
  { en: 'Skirt', ar: 'تنورة' },
  { en: 'Pants', ar: 'بنطلون' },
  { en: 'Shorts', ar: 'شورت' },
  { en: 'Blouse', ar: 'بلوزة' },
  { en: 'Cardigan', ar: 'كارديجان' },
  { en: 'Sweater', ar: 'سويتر' },
  { en: 'Coat', ar: 'معطف' },
  { en: 'Jeans', ar: 'جينز' },
  { en: 'Abaya', ar: 'عباية' },
  { en: 'Jumpsuit', ar: 'أوفرول' },
  { en: 'Vest', ar: 'صديري' },
  { en: 'Polo', ar: 'بولو' },
  { en: 'Tunic', ar: 'تونيك' },
  { en: 'Kaftan', ar: 'قفطان' },
  { en: 'Pajama', ar: 'بيجامة' },
];

/** The color values; style `g` has colors `(g - 1) % 10` and `(g + 2) % 10`. */
export const COLORS: readonly { en: string; ar: string }[] = [
  { en: 'Black', ar: 'أسود' },
  { en: 'White', ar: 'أبيض' },
  { en: 'Navy', ar: 'كحلي' },
  { en: 'Olive', ar: 'زيتي' },
  { en: 'Beige', ar: 'بيج' },
  { en: 'Grey', ar: 'رمادي' },
  { en: 'Red', ar: 'أحمر' },
  { en: 'Blue', ar: 'أزرق' },
  { en: 'Green', ar: 'أخضر' },
  { en: 'Brown', ar: 'بني' },
];

/**
 * The syllables of a seeded style's model name, as brands name their pieces ("Karimo"): three
 * syllables give 512 names, each on about 10 styles, so a model name is a selective fragment
 * the way real catalog names are. Two Arabic syllables carry a hamza (`أد`, `إم`), so a model
 * name can be typed without it.
 */
export const MODEL_SYLLABLES: readonly { en: string; ar: string }[] = [
  { en: 'ka', ar: 'كا' },
  { en: 'ri', ar: 'ري' },
  { en: 'mo', ar: 'مو' },
  { en: 'la', ar: 'لا' },
  { en: 'na', ar: 'نا' },
  { en: 'su', ar: 'سو' },
  { en: 'ad', ar: 'أد' },
  { en: 'im', ar: 'إم' },
];

/** The model name of model number `m` (0 to 511), in English and Arabic. */
export function modelName(m: number): { en: string; ar: string } {
  const n = MODEL_SYLLABLES.length;
  const parts = [m % n, Math.floor(m / n) % n, Math.floor(m / (n * n)) % n].map(
    (i) => MODEL_SYLLABLES[i] ?? { en: '', ar: '' },
  );
  return { en: parts.map((p) => p.en).join(''), ar: parts.map((p) => p.ar).join('') };
}

/** How many model names there are; style `g` has model `(g - 1) % MODEL_NAMES`. */
export const MODEL_NAMES = MODEL_SYLLABLES.length ** 3;

/** The size values of every seeded style; variant `k` has size `(k - 1) % 5`. */
export const SIZES: readonly string[] = ['XS', 'S', 'M', 'L', 'XL'];

/** How long one seeding step took, in seconds. */
export interface SeedStep {
  name: string;
  seconds: number;
}

/** The three stores orders are spread over, and the people, hats, and channels they use. */
const STORES = 3;
const USERS = 20;
const HATS = ['support', 'operations', 'warehouse', 'manager'];

/** Order `n` is the n-th seeded order; its store is `n % 3` and its number `#(1000 + n / 3)`. */
const lineGross = (n: string, j: number): string =>
  `((100 + ((${n} * 13 + ${j} * 7) % 40) * 25) * (1 + (${n} + ${j}) % 2))`;

function whole(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number`);
  return value;
}

/**
 * Loads the spec 0002 scale load straight into the tables, in `INSERT ... SELECT generate_series`
 * statements, as the owner role on a scratch database (every check and trigger still runs):
 * styles and variants (codes `SCALE-000001` and up), warehouses, opening movements with matching
 * balances, three stores and channels, customers (every 40th is canonical for two merged ones)
 * with phones, orders with lines and events, a carrier account with statements, lines, and one
 * match row per line, credit entries, and tasks. Returns the time each step took.
 */
export async function seedScale(owner: DatabaseConnection, seed: ScaleSeed): Promise<SeedStep[]> {
  const styles = whole('styles', seed.styles);
  const variants = styles * whole('variantsPerStyle', seed.variantsPerStyle);
  const orders = whole('orders', seed.orders);
  const perStore = orders / STORES;
  if (!Number.isInteger(perStore)) throw new Error('orders must divide by 3');
  if (seed.movements % 10 !== 0) throw new Error('movements must divide by 10');
  const days = whole('operatingDays', seed.operatingDays);
  const customers = whole('customers', seed.customers);
  const skuWidth = Math.max(6, String(variants).length);
  const sku = (n: string): string => `'SCALE-' || lpad((${n})::text, ${skuWidth}, '0')`;
  // Security review S9: seeded phones sit in +20 0..., a range no person can own. In E.164 the
  // national number after +20 never starts with 0 (0 is Egypt's trunk prefix, dropped in the
  // international form), so these pass the database's E.164 shape check yet can never ring
  // anyone, even when an EXPLAIN plan or a failure prints one to a CI log.
  const phone = (n: string, prefix: string): string => `'${prefix}' || lpad((${n})::text, 8, '0')`;
  const PRIMARY_PHONE = '+20000';
  const SECOND_PHONE = '+20001';
  const perStatement = Math.ceil(seed.settlementLines / seed.statements);
  const steps: SeedStep[] = [];

  const client = await owner.pool.connect();
  try {
    await client.query('SET synchronous_commit = off');
    await client.query("SET work_mem = '256MB'");
    const step = async (name: string, text: string): Promise<void> => {
      const started = performance.now();
      await client.query(text);
      steps.push({ name, seconds: (performance.now() - started) / 1000 });
    };

    const words = (list: readonly string[]) => `ARRAY[${list.map((w) => `'${w}'`).join(', ')}]`;
    const pick = (list: readonly { en: string; ar: string }[], lang: 'en' | 'ar', index: string) =>
      `(${words(list.map((w) => w[lang]))})[1 + (${index}) % ${list.length}]`;
    const scaleStyles = `(SELECT id, substr(style_code, 13)::int AS style FROM products
                          WHERE style_code LIKE 'SCALE-STYLE-%')`;
    const wordOf = `g - 1`;
    const garmentOf = `(g - 1) / ${STYLE_WORDS.length}`;
    const syllable = (lang: 'en' | 'ar', divisor: number) =>
      pick(MODEL_SYLLABLES, lang, `((g - 1) % ${MODEL_NAMES}) / ${divisor}`);
    const modelOf = (lang: 'en' | 'ar') => {
      const n = MODEL_SYLLABLES.length;
      return `${syllable(lang, 1)} || ${syllable(lang, n)} || ${syllable(lang, n * n)}`;
    };
    // Spec 0012 AC-5: every style is named in English and Arabic (a style word, a garment, and a
    // model name: "Linen Shirt Karimo"), eight styles in nine are in one of eight seasons, and every
    // variant has a size and a color value (5 sizes by the style's 2 colors) and one barcode.
    await step(
      'catalog',
      `INSERT INTO seasons (code, name)
       SELECT 'SCALE-S' || g, jsonb_build_object('en', 'Scale season ' || g)
       FROM generate_series(1, ${SCALE_SEASONS}) g;
       INSERT INTO products (style_code, product_group_id, season_id, name, status)
       SELECT 'SCALE-STYLE-' || g, (SELECT id FROM product_groups WHERE code = 'MAIN'),
              (SELECT id FROM seasons WHERE code = 'SCALE-S' || (g % ${SCALE_SEASONS + 1})),
              jsonb_build_object(
                'en', ${pick(STYLE_WORDS, 'en', wordOf)} || ' ' || ${pick(GARMENTS, 'en', garmentOf)}
                      || ' ' || initcap(${modelOf('en')}),
                'ar', ${pick(GARMENTS, 'ar', garmentOf)} || ' ' || ${pick(STYLE_WORDS, 'ar', wordOf)}
                      || ' ' || ${modelOf('ar')}),
              'active'
       FROM generate_series(1, ${styles}) g;
       INSERT INTO product_options (product_id, name, position, values)
       SELECT p.id, '{"en": "Size", "ar": "المقاس"}'::jsonb, 0,
              '${JSON.stringify(SIZES.map((size) => ({ en: size })))}'::jsonb
       FROM ${scaleStyles} p;
       INSERT INTO product_options (product_id, name, position, values)
       SELECT p.id, '{"en": "Color", "ar": "اللون"}'::jsonb, 1, jsonb_build_array(
                jsonb_build_object('en', ${pick(COLORS, 'en', 'p.style - 1')},
                                   'ar', ${pick(COLORS, 'ar', 'p.style - 1')}),
                jsonb_build_object('en', ${pick(COLORS, 'en', 'p.style + 2')},
                                   'ar', ${pick(COLORS, 'ar', 'p.style + 2')}))
       FROM ${scaleStyles} p;
       INSERT INTO product_variants (product_id, sku, option_values, base_uom_id, price)
       SELECT p.id, ${sku(`(p.style - 1) * ${seed.variantsPerStyle} + k`)},
              jsonb_build_object('0', (k - 1) % ${SIZES.length}, '1', (k - 1) / ${SIZES.length}),
              (SELECT id FROM uoms WHERE code = 'pc'), 100 + k * 25
       FROM ${scaleStyles} p CROSS JOIN generate_series(1, ${seed.variantsPerStyle}) k;
       INSERT INTO barcodes (variant_id, uom_id, code)
       SELECT v.id, v.base_uom_id, ${SCALE_BARCODE_SQL}
       FROM product_variants v WHERE v.sku LIKE 'SCALE-%'`,
    );
    await step(
      'locations',
      `INSERT INTO locations (code, name, kind)
       SELECT 'SCALE-' || g, jsonb_build_object('en', 'Scale warehouse ' || g), 'warehouse'
       FROM generate_series(1, ${whole('locations', seed.locations)}) g`,
    );
    await step(
      'movements',
      `WITH grp AS (
         INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at)
         SELECT 'scale-' || g, 'seed', 'opening_balance', uuidv7(), now() - interval '1 day'
         FROM generate_series(1, ${seed.movements / 10}) g
         RETURNING id, substr(idempotency_key, 7)::int AS n
       )
       INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost,
                                    total_cost, effective_at, recorded_at)
       SELECT grp.id, v.id, l.id, 10, 2.5, 25.00, now() - interval '1 day', now()
       FROM generate_series(0, ${seed.movements - 1}) i
       JOIN grp ON grp.n = i / 10 + 1
       JOIN product_variants v ON v.sku = ${sku('i % ' + variants + ' + 1')}
       -- Review R15: every SKU gets movements at distinct locations, and the SKUs alternate
       -- between the two halves of the location list, so all of them hold stock.
       JOIN locations l ON l.code = 'SCALE-' || (((i / ${variants}) + (i % ${variants}) % 2 * ${Math.ceil(seed.locations / 2)}) % ${seed.locations} + 1)`,
    );
    await step(
      'stock levels',
      `INSERT INTO stock_levels (variant_id, location_id, on_hand, avg_unit_cost, total_value)
       SELECT variant_id, location_id, sum(quantity), 2.5, sum(total_cost)
       FROM stock_movements GROUP BY 1, 2`,
    );
    await step(
      'people, stores, channels',
      `INSERT INTO users (name, email)
       SELECT 'Scale user ' || g, 'scale-user-' || lpad(g::text, 3, '0') || '@example.test'
       FROM generate_series(1, ${USERS}) g;
       INSERT INTO stores (code, name, public_name, kind)
       SELECT 'SCALE-S' || g, jsonb_build_object('en', 'Scale store ' || g),
              jsonb_build_object('en', 'Scale store ' || g), 'shopify'
       FROM generate_series(1, ${STORES}) g;
       INSERT INTO channels (code, name, kind, default_store_id)
       SELECT 'scale-c' || g, jsonb_build_object('en', 'Scale channel ' || g),
              (ARRAY['shopify', 'landing_page', 'whatsapp'])[g]::channel_kind,
              (SELECT id FROM stores WHERE code = 'SCALE-S' || g)
       FROM generate_series(1, ${STORES}) g`,
    );
    await step(
      'customers',
      `WITH g AS (SELECT n, uuidv7() AS id FROM generate_series(1, ${customers}) n)
       INSERT INTO customers (id, name, merged_into_id)
       SELECT g.id, 'Scale customer ' || g.n, m.id
       FROM g LEFT JOIN g m ON g.n > 40 AND g.n % 40 IN (1, 2) AND m.n = g.n - g.n % 40`,
    );
    await step(
      'customer phones',
      `WITH c AS (SELECT id, substr(name, 16)::int AS n FROM customers WHERE name LIKE 'Scale customer %')
       INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
       SELECT id, ${phone('n', PRIMARY_PHONE)}, 'mobile'::customer_phone_kind, true FROM c
       UNION ALL
       SELECT id, ${phone('n', SECOND_PHONE)}, 'mobile'::customer_phone_kind, false FROM c WHERE n <= ${whole('phones', seed.phones) - customers}`,
    );
    await step(
      'orders',
      `WITH s AS (SELECT array_agg(id ORDER BY code) AS a FROM stores WHERE code LIKE 'SCALE-S%'),
            ch AS (SELECT array_agg(id ORDER BY code) AS a FROM channels WHERE code LIKE 'scale-c%'),
            u AS (SELECT array_agg(id ORDER BY email) AS a FROM users WHERE email LIKE 'scale-user-%'),
            cu AS (SELECT substr(name, 16)::int AS n, id FROM customers WHERE name LIKE 'Scale customer %'),
            o0 AS (
              SELECT n, n % ${STORES} AS si, n / ${STORES} AS k,
                     ${days - 1} - ((n / ${STORES}) * ${days} / ${perStore}) AS off,
                     1 + (n * 7) % ${customers} AS cn,
                     (${lineGross('n', 1)} + CASE WHEN n % 5 < 2 THEN ${lineGross('n', 2)} ELSE 0 END)::numeric(14,2) AS all_lines,
                     CASE WHEN ${days - 1} - ((n / ${STORES}) * ${days} / ${perStore}) < 7 THEN 'new'
                          ELSE (ARRAY['delivered','delivered','delivered','delivered','delivered','delivered','delivered',
                                      'returned_to_origin','cancelled','refused'])[1 + n % 10] END AS state
              FROM generate_series(1, ${orders}) n
            ),
            -- Review R2: a wholly cancelled order's lines are all cancelled, so its line total is 0
            -- (the orders child sums lines that are not cancelled); it charges no shipping and
            -- holds no prepayment, so its total, COD expected, and COD due are 0 too.
            o AS (
              SELECT o0.*,
                     CASE WHEN state = 'cancelled' THEN 0 ELSE all_lines END AS gross,
                     CASE WHEN state = 'cancelled' THEN 0 ELSE 60 END AS ship,
                     CASE WHEN n % 7 = 0 AND state <> 'cancelled' THEN 50 ELSE 0 END AS prepaid
              FROM o0
            )
       INSERT INTO orders (store_id, channel_id, order_number, customer_id, placed_at, fulfillment_state,
                           cash_state, outcome, lines_gross_amount, shipping_charged_amount, total_amount,
                           prepaid_amount, cod_expected_amount, cod_due_amount, cod_collected_amount,
                           delivered_amount, payment_method, prepaid_method, ship_to_name, ship_to_phone,
                           confirmed_at, confirmed_by, cancelled_at, cancel_reason_code, refused_reason_code)
       SELECT s.a[1 + o.si], ch.a[1 + o.n % ${STORES}], '#' || (1000 + o.k), cu.id,
              now() - o.off * interval '1 day' - ((o.n * 7919) % 86400) * interval '1 second',
              o.state::order_fulfillment_state,
              (CASE WHEN o.prepaid > 0 AND o.state IN ('new', 'delivered') THEN 'prepaid'
                    WHEN o.state = 'new' THEN 'unpaid'
                    WHEN o.state = 'delivered' THEN CASE WHEN o.n % 2 = 0 THEN 'reconciled' ELSE 'remitted' END
                    ELSE 'nothing_to_collect' END)::order_cash_state,
              (CASE o.state WHEN 'new' THEN 'open' WHEN 'delivered' THEN 'kept'
                            WHEN 'cancelled' THEN 'cancelled_before_shipping' ELSE 'failed_delivery' END)::order_outcome,
              o.gross, o.ship, o.gross + o.ship, o.prepaid, o.gross + o.ship - o.prepaid,
              o.gross + o.ship - o.prepaid,
              CASE WHEN o.state = 'delivered' AND o.prepaid = 0 THEN o.gross + 60 ELSE 0 END,
              CASE WHEN o.state = 'delivered' THEN o.gross + 60 ELSE 0 END,
              (CASE WHEN o.prepaid > 0 THEN 'instapay' ELSE 'cod' END)::order_payment_method,
              CASE WHEN o.prepaid > 0 THEN 'instapay'::order_payment_method END,
              'Scale customer ' || o.cn, ${phone('o.cn', PRIMARY_PHONE)},
              CASE WHEN o.state <> 'new' THEN now() - o.off * interval '1 day' END,
              CASE WHEN o.state <> 'new' THEN u.a[1 + o.n % ${USERS}] END,
              CASE WHEN o.state = 'cancelled' THEN now() - o.off * interval '1 day' END,
              CASE WHEN o.state = 'cancelled' THEN 'customer_cancelled' END,
              CASE WHEN o.state = 'refused' THEN 'size' END
       FROM o CROSS JOIN s CROSS JOIN ch CROSS JOIN u JOIN cu ON cu.n = o.cn`,
    );
    await step(
      'order lines',
      `WITH s AS (SELECT array_agg(id ORDER BY code) AS a FROM stores WHERE code LIKE 'SCALE-S%'),
            x AS (
              SELECT o.id, o.fulfillment_state AS state, j,
                     3 * (substr(o.order_number, 2)::int - 1000) + array_position(s.a, o.store_id) - 1 AS n
              FROM orders o CROSS JOIN s CROSS JOIN generate_series(1, 2) j
            ),
            l AS (
              SELECT x.id, x.state, x.j, x.n,
                     (100 + ((x.n * 13 + x.j * 7) % 40) * 25) AS price,
                     (1 + (x.n + x.j) % 2) AS qty
              FROM x WHERE x.j = 1 OR x.n % 5 < 2
            )
       INSERT INTO order_lines (order_id, position, variant_id, title, quantity, unit_price, net_amount,
                                tax_rate, tax_amount, gross_amount, line_state, cancel_reason_code)
       SELECT l.id, l.j, v.id, 'Scale item', l.qty, l.price,
              round(l.price * l.qty / 1.14, 2), 14.00,
              l.price * l.qty - round(l.price * l.qty / 1.14, 2), l.price * l.qty,
              (CASE l.state WHEN 'new' THEN 'open' WHEN 'delivered' THEN 'delivered'
                            WHEN 'cancelled' THEN 'cancelled' ELSE 'returned_to_origin' END)::order_line_state,
              CASE WHEN l.state = 'cancelled' THEN 'customer_cancelled' END
       FROM l JOIN product_variants v ON v.sku = ${sku(`1 + (l.n * 31 + l.j * 17) % ${variants}`)}`,
    );
    // Spec 0013 task 16: the order list filters read flags the plain seed leaves at their defaults.
    // Each flag lands on a small, real looking share, picked by a hash of the row id so the same
    // seed always plants the same rows: a write back hold on 3 orders in 100 (1 in 5 of them
    // failed), a second ship to phone on 2 in 100, an exchange replacement on 1 in 200, a short
    // line on 1 line in 5 of the open orders, and pieces awaiting restock on 1 line in 25 of the
    // returned, refused, and cancelled orders.
    await step(
      'order flags',
      `UPDATE orders SET
         write_back_state = (CASE WHEN abs(hashtext(id::text)) % 100 < 3
                                  THEN CASE WHEN abs(hashtext(id::text)) % 15 = 0 THEN 'failed' ELSE 'waiting' END
                                  ELSE 'none' END)::order_write_back_state,
         ship_to_phone_alt = CASE WHEN abs(hashtext(id::text || 'alt')) % 100 < 2
           THEN ${phone(`1 + abs(hashtext(id::text)) % ${customers}`, SECOND_PHONE)} END;
       WITH pick AS (SELECT id, lag(id) OVER (ORDER BY placed_at, id) AS previous_id FROM orders)
       UPDATE orders o SET type = 'exchange_replacement', original_order_id = pick.previous_id
       FROM pick
       WHERE pick.id = o.id AND pick.previous_id IS NOT NULL AND abs(hashtext(o.id::text || 'xr')) % 200 = 0;
       UPDATE order_lines l SET short_quantity = 1
       FROM orders o
       WHERE o.id = l.order_id AND o.fulfillment_state = 'new' AND abs(hashtext(l.id::text)) % 5 = 0;
       UPDATE order_lines l SET stock_out_quantity = l.quantity, awaiting_restock_quantity = 1,
         awaiting_restock_since = o.placed_at + interval '3 days'
       FROM orders o
       WHERE o.id = l.order_id AND o.fulfillment_state IN ('returned_to_origin', 'refused', 'cancelled')
         AND abs(hashtext(l.id::text)) % 25 = 0`,
    );
    // Security review S1: recorded_at on order events belongs to the database, which stamps the
    // moment of the insert. The seed plants a history spread over three years, so it turns the
    // stamp off as the owner for this one insert and always turns it back on.
    await client.query('ALTER TABLE order_events DISABLE TRIGGER order_events_0_stamp_recorded_at');
    try {
      await step(
        'order events',
        `WITH u AS (SELECT array_agg(id ORDER BY email) AS a FROM users WHERE email LIKE 'scale-user-%')
       INSERT INTO order_events (order_id, machine, from_state, to_state, actor_type, actor_id,
                                 occurred_at, recorded_at)
       SELECT o.id, 'fulfillment', e.from_state, e.to_state, e.actor::order_actor_type,
              CASE WHEN e.actor = 'person' THEN u.a[1 + abs(hashtext(o.id::text)) % ${USERS}] END,
              o.placed_at + e.after, o.placed_at + e.after
       FROM orders o CROSS JOIN u
       CROSS JOIN LATERAL (VALUES
         (1, NULL::text, 'new', 'import', interval '0'),
         (2, 'new', 'confirmed', 'person', interval '2 hours'),
         (3, 'confirmed', o.fulfillment_state::text,
             CASE WHEN o.fulfillment_state = 'cancelled' THEN 'person' ELSE 'carrier' END, interval '2 days')
       ) AS e(step, from_state, to_state, actor, after)
       WHERE e.step = 1 OR o.fulfillment_state <> 'new'`,
      );
    } finally {
      await client.query(
        'ALTER TABLE order_events ENABLE TRIGGER order_events_0_stamp_recorded_at',
      );
    }
    await step(
      'credit entries',
      `WITH c AS (SELECT substr(name, 16)::int AS n, id FROM customers WHERE name LIKE 'Scale customer %'),
            e AS (
              SELECT g AS e, 40 * (1 + g % 2900) + (g / 2900) % 3 AS cn,
                     (ARRAY['opening_balance', 'goodwill', 'order_consumption'])[1 + g % 3] AS kind,
                     50 + (g % 10) * 25 AS amount
              FROM generate_series(1, ${whole('creditEntries', seed.creditEntries)}) g
            )
       INSERT INTO credit_entries (posting_id, customer_id, kind, funding, amount, order_id, reason_code,
                                   actor_type, idempotency_key, request_hash, effective_at)
       SELECT uuidv7(), c.id, e.kind::credit_entry_kind,
              (CASE e.kind WHEN 'opening_balance' THEN 'cod_cash' ELSE 'credit_only' END)::credit_funding,
              CASE WHEN e.kind = 'order_consumption' THEN -e.amount ELSE e.amount END,
              o.id,
              CASE e.kind WHEN 'opening_balance' THEN 'seed.opening' WHEN 'goodwill' THEN 'goodwill.apology'
                          ELSE 'order.consumption' END,
              'rule', 'scale-credit-' || e.e, 'seed',
              now() - (e.e % ${days}) * interval '1 day'
       FROM e JOIN c ON c.n = e.cn
       LEFT JOIN orders o ON e.kind = 'order_consumption'
                         AND o.order_number = '#' || (1000 + e.e)
                         AND o.store_id = (SELECT id FROM stores WHERE code = 'SCALE-S1')`,
    );
    await step(
      'settlement statements',
      `WITH conn AS (
         INSERT INTO connections (provider, label) VALUES ('bosta', 'Scale carrier') RETURNING id
       ), acc AS (
         INSERT INTO settlement_accounts (code, name, owner_type, owner_connection_id)
         SELECT 'SCALE-BOSTA', jsonb_build_object('en', 'Scale Bosta'), 'carrier', id FROM conn
         RETURNING id
       )
       INSERT INTO settlement_statements (account_id, kind, external_reference, covers_from, covers_to,
                                          statement_total)
       SELECT acc.id, 'carrier_file', 'CYCLE-' || lpad(s::text, 5, '0'),
              current_date - ((${seed.statements} - s) * ${days} / ${seed.statements}),
              current_date - ((${seed.statements} - s) * ${days} / ${seed.statements}), 0
       FROM acc CROSS JOIN generate_series(1, ${seed.statements}) s`,
    );
    await step(
      'settlement lines',
      `WITH s AS (SELECT array_agg(id ORDER BY code) AS a FROM stores WHERE code LIKE 'SCALE-S%'),
            st AS (SELECT id, account_id, covers_from, substr(external_reference, 7)::int AS n
                   FROM settlement_statements WHERE external_reference LIKE 'CYCLE-%')
       INSERT INTO settlement_lines (account_id, statement_id, line_kind, amount, external_line_ref,
                                     occurred_on, tracking_number, business_reference, store_id)
       SELECT st.account_id, st.id, 'cod_collected', 100 + (g % 40) * 25, 'L-' || g, st.covers_from,
              'BST' || lpad(g::text, 9, '0'),
              '#' || (1000 + (1 + (g - 1) % ${orders}) / ${STORES}),
              s.a[1 + (1 + (g - 1) % ${orders}) % ${STORES}]
       FROM s CROSS JOIN generate_series(1, ${seed.settlementLines}) g
       JOIN st ON st.n = 1 + (g - 1) / ${perStatement}`,
    );
    await step(
      'settlement matches',
      `INSERT INTO settlement_line_matches (line_id, result, order_id, account_code, reason_code,
                                           matched_by_type, rule_code)
       SELECT l.id, r.result::settlement_match_result,
              CASE WHEN r.result = 'matched' THEN o.id END,
              CASE WHEN r.result = 'accounted' THEN 'carrier_deposit' END,
              CASE WHEN r.result = 'unmatched' THEN 'no_order_for_tracking' END,
              'rule', CASE WHEN r.result = 'matched' THEN 'tracking_and_amount' END
       FROM settlement_lines l
       JOIN orders o ON o.store_id = l.store_id AND o.order_number = l.business_reference
       CROSS JOIN LATERAL (SELECT CASE substr(l.external_line_ref, 3)::int % 20
                                      WHEN 0 THEN 'unmatched' WHEN 1 THEN 'unmatched'
                                      WHEN 2 THEN 'accounted' ELSE 'matched' END AS result) r`,
    );
    // Spec 0016 AC-26: a task always names its hat (`tasks_owner_hat_set`); a person owned one names
    // the hat she acts under as well.
    await step(
      'tasks',
      `WITH u AS (SELECT array_agg(id ORDER BY email) AS a FROM users WHERE email LIKE 'scale-user-%'),
            t AS (
              SELECT n,
                     CASE WHEN n > ${seed.tasks - seed.openTasks} THEN 'open'
                          WHEN n % 50 = 0 THEN 'cancelled' ELSE 'done' END AS status,
                     now() - ((${seed.tasks} - n)::numeric / ${seed.tasks} * ${days}) * interval '1 day' AS created
              FROM generate_series(1, ${whole('tasks', seed.tasks)}) n
            )
       INSERT INTO tasks (type, linked_type, linked_id, owner_user_id, owner_hat, due_at, status,
                          outcome_code, dedupe_key, created_by_type, closed_at, closed_by, created_at)
       SELECT 'confirmation.call', 'order', uuidv7(),
              CASE WHEN t.n % 2 = 0 THEN u.a[1 + (t.n / 2) % ${USERS}] END,
              (ARRAY[${HATS.map((hat) => `'${hat}'`).join(', ')}])[1 + (t.n / 2) % ${HATS.length}],
              t.created + interval '1 day', t.status::task_status,
              CASE WHEN t.status = 'done' THEN 'confirmed' END,
              'scale_task:' || t.n, 'system_job',
              CASE WHEN t.status <> 'open' THEN t.created + interval '1 hour' END,
              CASE WHEN t.status <> 'open' THEN u.a[1 + t.n % ${USERS}] END,
              t.created
       FROM t CROSS JOIN u`,
    );
    await step('analyze', 'ANALYZE');
  } finally {
    client.release();
  }
  return steps;
}

/** Random seeded stock balances (a SKU and a location), for the stock reads and the posting. */
export async function randomScaleKeys(
  owner: DatabaseConnection,
  count: number,
): Promise<{ variantId: string; locationId: string }[]> {
  const { rows } = await owner.pool.query<{ variant_id: string; location_id: string }>(
    // Review R15: a uniform sample of balances, not the adjacent pages TABLESAMPLE SYSTEM reads.
    `SELECT variant_id, location_id FROM stock_levels ORDER BY random() LIMIT $1`,
    [count],
  );
  return rows.map((row) => ({ variantId: row.variant_id, locationId: row.location_id }));
}
