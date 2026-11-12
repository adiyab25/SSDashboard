# Verify: catalog, styles and variants · spec 0012 · written 2026-11-07

_Steps derived from spec 0012 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Each milestone of the Build plan ticks the steps it makes runnable._

## UI / manual
- [ ] Sign in as a person with the `warehouse` hat, open `/skus`, type `اسود` → variants of a style named `أسود` are listed; type `٢٠٤٤` → SKU `2044-BLK-M` is listed; type `black tee` → the `Tee` variants with color Black are listed → AC-3
- [x] On `/skus`, each row shows code, name with size and color, style code, season ("No season" when none), group, price, and status; filter by a season, then by "No season", then by a group → only matching rows → AC-4
- [ ] Type a barcode printed on a label into the search → exactly that variant; open it → the SKU page shows its barcodes and links to its style → AC-3, AC-4
- [x] Sign in as the manager, open `/seasons`, create `SS27` with dates, try `ss27` again → "code taken" (409 `SEASON_CODE_TAKEN`); archive `SS27` → it leaves the style edit picker; try to archive `CORE` → refused (409 `SEASON_PROTECTED`) → AC-6
- [x] On `/product-groups`, create `COLLECTIVE`; delete it while a style uses it → "in use" (409 `IN_USE`); try to delete `MAIN` → refused → AC-7
- [x] Open `/styles`, select three styles, "Set season" to `SS27` → all three show `SS27`; `/audit` lists three `style.edited` entries in one action → AC-9, AC-17
- [x] Open a style, add a variant with `Color: Navy` and `Size: L` → a Color option appears (role color) and the variant is listed; add the same combination again → "this size and color already exists" (409 `OPTION_COMBINATION_TAKEN`) → AC-10
- [x] Add a barcode already on another SKU → the message names that SKU's code (409 `BARCODE_TAKEN`) → AC-10
- [x] Archive one of two variants of a style → the style stays active; archive the other → the style shows archived; unarchive one → active again → AC-11
- [x] As a person holding `cost.view`, open a style with a style cost record and one variant override → that variant shows "override", the others "from style", a basis of estimate shows "estimate", a new style shows "Not set" → AC-12
- [x] Record a cost dated last month without a reason → the dialog asks for a reason (422 `REASON_REQUIRED`); with one → saved and listed first in the history → AC-13
- [x] As a `warehouse` person without the cost grant, open the same style → no cost column, no history panel, no record cost action → AC-12, AC-16
- [x] As a `support` person (no `catalog.edit`), open a style → no edit, add variant, or barcode actions; open `/seasons` by its address → the no access state → AC-16, AC-18
- [ ] On a style created by the channel fixture, the name in the title's language and each variant's price show "From Shopify" read only → AC-15, AC-18
- [ ] Switch to Arabic → every catalog page is right to left with Arabic labels, codes stay left to right; keyboard only (Tab, Enter, Escape) edits a style and assigns a season; at phone width the tables show as cards; axe reports no violation in either language → AC-18

## Commands
- [x] `pnpm --filter @ssdashboard/db test:e2e -- test/search-normalize.e2e-spec.ts` → the fixture pairs and the trigger recomputation cases pass → AC-1, AC-2
- [x] `pnpm --filter @ssdashboard/api exec vitest run src/catalog` → the search SQL builder cases (three branches, short words, escaping, 5 word cap) pass → AC-3
- [x] `pnpm build && pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/master-data.e2e-spec.ts test/styles.e2e-spec.ts test/seasons-groups.e2e-spec.ts` → search, filters, styles, options, barcodes, archive, seasons, and groups pass → AC-3, AC-4, AC-6 to AC-11
- [x] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/cost.e2e-spec.ts` → `costForMany` equals `costFor` per id, inherited and override, backdating reason, no `cost` key without the grant → AC-12, AC-13, AC-16
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/channel-sync.e2e-spec.ts` → idempotent second run with no audit rows, Default Title, Arabic title, `needs_sku`, `linked`, two stores in parallel, non source store, `sku_mismatch`, `barcode_conflict`, `option_conflict` → AC-14, AC-15, AC-17
- [x] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/access-sweep.e2e-spec.ts` → every new route answers 403 exactly where the matrix says, no `COST_FIELD_KEYS` key without `cost.view` → AC-16
- [ ] `pnpm test` → the audit registry test finds every new code with both labels and its proof file → AC-17
- [ ] `pnpm --filter @ssdashboard/api test:scale` → the six search reads under 150 ms at p95 with `product_variants_search_trgm_idx`, `product_variants_sku_c_idx`, and `barcodes_code_unique` in their plans; record the measured values below → AC-5
- [ ] `pnpm --filter @ssdashboard/web test:e2e -- e2e/styles.spec.ts e2e/master-data.spec.ts` → both languages, keyboard, axe, phone width → AC-18
- [ ] `pnpm lint` → no hard coded string, logical CSS only, READMEs present for the new web folders → AC-18

## Value sourcing checks
- [x] Rename a style in SQL as the owner and read its variants → `search_text` changed, `updated_at` unchanged → AC-2 (trigger source, stale check untouched)
- [x] Search `TEE-BLK` and `tee blk` → the same rows (both normalized by `ssd_search_normalize`) → AC-3 (one normalization)
- [x] Search with Arabic Indic digits for a barcode → found (digits through `normalizeDigits`) → AC-3
- [ ] At 23:30 Cairo time, record a cost dated today without a reason → accepted (today is `ssd_operating_day(now())`, not the UTC date) → AC-13
- [ ] Set `catalog.store_product_groups` for store B to `COLLECTIVE` and apply a new fixture product from store B → the new style is in `COLLECTIVE`; with the group archived → `MAIN` → AC-14
- [ ] Set `catalog.source_store_id` to store A and apply a price change from store B → price unchanged, outcome `unchanged` → AC-15
- [ ] Apply a product titled in Arabic → `channel_name_language = 'ar'`; editing the Arabic name in the app answers 409 `FIELD_OWNED_BY_CHANNEL`, the English name saves → AC-15

## Measured
_Filled by milestone 1 task 5: the p95 of each search read at 50,000 variants and the date of the run._

Measured 2026-11-08 by `pnpm --filter @ssdashboard/api test:scale` on the dev PostgreSQL 18.6 (Docker, Windows host), with the scale seed of 50,000 variants under 5,000 styles (every style named in English and Arabic as a style word, a garment, and a model name such as "Linen Shirt Karimo"; every variant with a size, a color, and one barcode; eight styles in nine in one of eight seasons). p95 over 60 timed runs after 20 warm up runs, each run being both statements `GET /api/skus` issues (`ssd_search_normalize(q)`, then the three branch union). Every plan used all three branch indexes: `barcodes_code_unique` (barcode), `product_variants_sku_c_idx` (prefix), and `product_variants_search_trgm_idx` (contains); the suite asserts each.

| Read | Inputs | Budget (ms) | p95 (ms) |
|---|---|---|---|
| Code prefix | the first 10 characters of a random SKU code (`SCALE-0001`) | 150 | 26.5 |
| English name fragment | the first 5 letters of a model name (`karim`) | 150 | 17.2 |
| Arabic fragment without hamza | an Arabic model name that has a hamza, typed without it | 150 | 19.8 |
| Two words | a garment and a style word (`shirt linen`) | 150 | 6.3 |
| Exact barcode | a random seeded barcode (13 digits) | 150 | 4.3 |
| Fragment with a season filter | a garment (`tee`) and a season id | 150 | 10.7 |

A first run on the same day used only the 45 style words and garments as fragments. Each matches 4 to 10% of the variants, so the planner (correctly, and fast) walked `product_variants_sku_c_idx` in code order for the contains branch instead of the trigram index, and the plan check failed. The model names give fragments the selectivity real catalog names have. In that run the fragment with a season filter, now a garment, was 46.2 ms.
