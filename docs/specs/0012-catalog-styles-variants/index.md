# 0012. Catalog, styles and variants: one normalized search column, style screens, visible cost, and a channel upsert contract

**Date**: 2026-11-07
**Status**: Accepted 2026-11-07 (accepted by the owner with every owner decision as recommended; not yet built)
**Feature**: scope feature 12, [Catalog, styles & variants](../../scope/confirmation-to-cash.md) (Slice 1a, Core, Beta)
**Depends on**: the built catalog of [spec 0002](../0002-core-data-model/index.md) ([catalog child](../0002-core-data-model/0002-catalog-locations.md): `products` as styles, `seasons`, `product_groups`, `cost_records`, `CostService`) and [spec 0006](../0006-core-stock-loop/index.md) (SKU create, edit, archive, delete, list); permissions of [spec 0008](../0008-roles-as-hats/index.md); `AuditService` of [spec 0010](../0010-audit-trail/index.md); three settings requested from feature 9 ([spec 0009](../0009-settings-toggles-bundles/index.md), see *Settings requested from feature 9*). Neighbours, written in parallel: spec 0015 (the Shopify connector calls `CatalogChannelSync`), spec 0011 (stock ledger and locations), spec 0013 (orders reference variants).

> Amended 2026-11-08, with what [spec 0009](../0009-settings-toggles-bundles/index.md)'s wave 1 amendment (2026-11-07) owes this spec: in *Settings requested from feature 9*, "manager" reads `whoMayChange: settings.manage` (a hat is not a permission), exposure is `staff`, `catalog.store_product_groups` needs a reason and carries a warning naming the accountant's export (wave 1 review W17), and the editors of the three keys wait for pickers, as spec 0009's *Rows requested by specs 0012 to 0015* says. Where this spec and spec 0009 differ on these rows, spec 0009 wins.

## Summary

This feature makes the catalog the way a clothing brand thinks of it: styles (what a customer calls "the shirt"), seasons, product groups, and the sizes and colors under each style, mostly arriving from Shopify. Staff find any variant by name, SKU code, or barcode, in Arabic or English, typed loosely (with or without hamza, Arabic or Western digits, words in any order), and the answer comes back well under a second at 50,000 variants because every variant carries one normalized search text (a cleaned up copy of its names and codes) that one trigram index (an index of three letter pieces that finds text fragments fast) serves. Managers keep seasons and product groups, staff edit styles and add sizes, and people with the cost permission see which cost each variant inherits from its style or overrides. The Shopify connector (spec 0015) creates and updates products only through one catalog service whose contract, matching rules, and field ownership this spec fixes.

## Requirements

**User stories**:
- As support or warehouse staff, I want to type part of a name, a SKU code, or scan a barcode, in Arabic or English, and find the variant at once, so that I never scroll a 10,000 row list.
- As operations, I want each variant to show its style, season, product group, size, and color, so that I know exactly which piece it is.
- As the manager, I want to keep the brand's seasons and product groups and put styles into them in bulk, so that launches and exports group the way the brand does.
- As the owner (holding the cost permission), I want to see each variant's cost in force, inherited from its style or overridden, and add a cost when an invoice arrives, so that margin is never a silent zero.
- As the Shopify connector (spec 0015), I want one idempotent way to create or update a style and its variants from a channel product, with clear rules on which fields Shopify owns, so that a resync never duplicates or overwrites the brand's own work.

**Acceptance criteria**:
- **AC-1** (normalization): one SQL function `ssd_search_normalize(text) RETURNS text`, `IMMUTABLE`, `PARALLEL SAFE`, a plain inlinable `sql` function with schema qualified calls and no `SET` clause, is the only normalization of search text, used by the stored column (AC-2) and by every query (AC-3). In this order it: lowercases; maps Arabic Indic (U+0660 to U+0669) and Eastern Arabic Indic (U+06F0 to U+06F9) digits to `0` to `9`; maps `أ` `إ` `آ` `ٱ` to `ا`, `ى` to `ي`, `ئ` to `ي`, `ؤ` to `و`, `ة` to `ه`; removes the Arabic marks U+064B to U+065F and U+0670 and the tatweel U+0640; turns every run of characters that are not a letter or a digit into one space; trims. A database test holds a fixture table of input and expected output pairs (at least: `TEE-BLK-M` gives `tee blk m`; `قميص أسود` gives `قميص اسود`; `بِنطلون` gives `بنطلون`; `٢٠٤٤` gives `2044`; `مدرسة` gives `مدرسه`; `  Round   Top ` gives `round top`).
- **AC-2** (search document): every variant row carries `search_text`, equal to `ssd_search_normalize` of the space joined style English name, style Arabic name, style code, SKU code, and the English and Arabic labels of each of its option values. Triggers keep it true on every write path: inserting or updating a variant's `sku`, `option_values`, or `product_id`; updating a style's `name` or `style_code`; inserting, updating, or deleting a style's options. A style rename changes its variants' `search_text` but never their `updated_at`. A database test edits each source and finds every affected `search_text` equal to its recomputation.
- **AC-3** (search): `GET /api/skus?q=` (q trimmed, 1 to 100 characters) returns the union of three branches, each limited and ordered by SKU code (`COLLATE "C"`), then ordered and paged by code with the existing keyset cursor: (a) the variant whose barcode equals q after trimming, Western digits, and uppercasing; (b) variants whose code starts with q after Western digits and uppercasing (the existing prefix branch); (c) when the normalized q has at least one word of 3 or more characters, variants whose `search_text` contains every word of the normalized q (the first 5 distinct words, each matched as `LIKE '%word%'` with `%`, `_`, and `\` escaped). Archived variants answer only with `status=archived`. Examples that must pass: `اسود` finds a style named `أسود`; `٢٠٤٤` finds SKU `2044-BLK-M`; `black tee` finds style `Tee` with color value `Black`; `blk-m` finds `TEE-BLK-M`; a scanned barcode returns exactly its variant; `m` alone uses only the barcode and prefix branches.
- **AC-4** (filters and rows): `GET /api/skus` also filters by `seasonId` (a season id, or `none` for styles with no season), `productGroupId`, and `styleId`, combinable with q. Each row carries the SKU code, the style id, code, and name, the style's season (id, code, name) or null, its product group (id, code, name), the variant's option values as name and value pairs in both languages, price, and archived. `GET /api/skus/:id` adds the same fields plus the variant's barcodes. The SKU list screen shows code, name with option values, style code, season ("No season" when null), group, price, and status, with season and group filters, and the SKU page links to its style.
- **AC-5** (scale): with the scale seed of 50,000 variants under 5,000 styles (10 per style, every style named in English and Arabic, every variant with a size and a color value and one barcode), the 95th percentile over at least 50 timed runs on the dev Postgres is under 150 ms for each of: a code prefix, an English name fragment, an Arabic fragment typed without hamza, a two word query, an exact barcode, and a fragment with a season filter. The contains branch's plan uses `product_variants_search_trgm_idx`, the prefix branch `product_variants_sku_c_idx`, and the barcode branch `barcodes_code_unique`; the scale suite asserts each.
- **AC-6** (seasons): a person with `catalog.manage` creates, edits, archives, unarchives, and deletes seasons. A season has a code (trimmed, uppercased, `^[A-Z0-9._-]{1,16}$`, unique, 409 `SEASON_CODE_TAKEN`), a name in at least one language, and optional start and end dates in order (422 `INVALID_INPUT`). Edits carry the microsecond `updatedAt` (409 `STALE_RECORD`). An archived season leaves the pickers and filters' default list but stays on the styles and cost records that hold it, and cannot be newly given to a style (422 `ARCHIVED`). Delete works only while no style or cost record references it (409 `IN_USE`). The seeded `CORE` season can be renamed but never archived, deleted, or recoded (409 `SEASON_PROTECTED`).
- **AC-7** (product groups): the same rules as AC-6 for product groups (code pattern and uniqueness 409 `PRODUCT_GROUP_CODE_TAKEN`, name, stale check, archive, delete only unreferenced, 422 `ARCHIVED` on new assignment); the seeded `MAIN` group is protected (409 `PRODUCT_GROUP_PROTECTED`).
- **AC-8** (styles): `GET /api/styles` lists styles (code, name, season, group, count of active variants, archived) ordered and paged by style code (`COLLATE "C"`, keyset, 50 per page), filtered by `seasonId` (or `none`), `productGroupId`, `status`, and q, where a style matches when any of its variants matches AC-3 branch (b) or (c), or its style code starts with the uppercased q. `GET /api/styles/:id` returns the style (code, name, description, season, group, tags, product type, brand, archived, `updatedAt`), its options (name, role, ordered values), and its variants (code, option values, price, archived, barcodes). The `/styles` and `/styles/[id]` screens show them, and the SKU page links to the style page.
- **AC-9** (editing styles): a person with `catalog.edit` edits a style's name, description, season, group, and tags (at most 50 tags of at most 64 characters) with the stale check, and assigns a season, a group, or both to 1 to 200 selected styles in one transaction (all or nothing; any unknown id answers 404 `NOT_FOUND` with the missing ids, any archived target 422 `ARCHIVED`). A person with `catalog.manage` changes a style code (the SKU code shape, unique, 409 `STYLE_CODE_TAKEN`, stale check).
- **AC-10** (variants, options, barcodes): `POST /api/products` (spec 0006) also accepts an optional style code, season, and product group (defaults: the SKU code, none, `MAIN`). A person with `catalog.edit` adds a variant to a style with a SKU code (spec 0006 AC-1 rules, 409 `SKU_TAKEN`), up to 3 option name and value pairs, an optional price, and an optional barcode: an option name the style lacks appends a new option (422 `TOO_MANY_OPTIONS` past 3), a value the option lacks is appended to its values, names and values match after `ssd_search_normalize`. Two active variants of one style never share the same option values (409 `OPTION_COMBINATION_TAKEN`, also on unarchive). An option's role is `size` when its normalized name is one of `size`, `sizes`, `مقاس`, `المقاس`, `القياس`; `color` for `color`, `colour`, `لون`, `اللون`; otherwise `other`. A person with `catalog.edit` adds a barcode to a SKU (trimmed, Western digits, uppercased, `^[A-Z0-9._-]{1,64}$`, unit `pc`; 409 `BARCODE_TAKEN` naming the SKU code that holds it) and removes one.
- **AC-11** (archive with several variants): archiving a SKU (spec 0006 AC-3, through inventory's `sku-lifecycle`) archives its style only when no other active variant of that style remains; unarchiving a SKU unarchives its style. Delete keeps its rule (the style goes when its last variant goes).
- **AC-12** (inherited cost, visible): for a caller holding `cost.view`, every variant on the style page shows its cost in force on today's operating day from `CostService.costForMany(variantIds, day)`: the unit cost, its cost basis (an `estimate` labelled "estimate"), its effective date, and whether it is inherited from the style or an override of this variant, or "Not set" when none exists, never 0. `costForMany` returns, for each id, exactly what `costFor` returns for it, in one query.
- **AC-13** (recording cost): a person holding `catalog.edit` and `cost.view` (owner decision Q-12.5, recommended) adds a cost record to a style, or to one of its variants as an override: season (required, any season, archived allowed), cost basis, unit cost (0 to 9,999,999,999.9999, at most 4 decimals), effective from (any date), and an optional source (up to 200 characters). A record whose effective date is before today's operating day needs a reason (422 `REASON_REQUIRED`). Records are only added (a correction is a newer record with the same date). The style page lists the style's records newest recorded first (`cost.view`). A variant id outside the style answers 404 `NOT_FOUND`.
- **AC-14** (channel upsert): `CatalogChannelSync.applyProduct(tx, input, actor)` takes one channel product (the `ChannelProductInput` contract below) inside the caller's transaction and returns one outcome per input variant. Each variant resolves in order: the given `variantId`; else an existing variant whose SKU code equals the input SKU after trimming and uppercasing (linked); else a new variant. A new variant joins the style of the input's first resolved variant, else the given `styleId`, else a new style (code from the Shopify handle, owner decision Q-12.1, recommended; group and season from the settings requested from feature 9). A variant with no SKU answers `needs_sku` and one whose SKU fails the code pattern `invalid_sku`, and neither is created (owner decision Q-12.2, recommended). The call never archives or deletes anything. Applying the same input twice returns `unchanged` for every variant the second time and writes no row and no audit entry. Two calls in parallel that both bring the same new SKU produce one variant; a style created in a call that ends with no variant is removed before commit. One channel product makes one style (owner decision Q-12.4, recommended).
- **AC-15** (field ownership): on a channel linked style or variant, each field has one owner, as the *Field ownership* table says. The app refuses a change to a field Shopify owns (409 `FIELD_OWNED_BY_CHANNEL` on the price of a linked variant and on the name language the channel writes), and the sync never changes a field the app owns; a Shopify SKU change on a linked variant answers `sku_mismatch` and is not applied. Content fields apply only from the source store (owner decision Q-12.3, recommended). `CatalogChannelSync.unlink(tx, { styleIds, variantIds })` clears the link so the app owns every field again.
- **AC-16** (access): reads (`GET /api/skus`, `/skus/:id`, `/styles`, `/styles/:id`, `/seasons`, `/product-groups`) need `stock.view`; style edits, bulk assign, adding variants, and barcodes need `catalog.edit`; style code changes and every season and product group write need `catalog.manage`; reading cost records needs `stock.view` and `cost.view`, adding one `catalog.edit` and `cost.view`. Without `cost.view` no answer carries a key from `COST_FIELD_KEYS`, which gains `cost`. Every new route has a fixture in the route sweep (`test/access-sweep.e2e-spec.ts`), and the sweep passes.
- **AC-17** (audit): each person action writes its entry in its own transaction through `AuditService.record`, with the codes in the *Audit* table and the new record types `style`, `season`, `product_group`; a bulk assign writes one entry per style with one correlation id; the channel sync writes `style.channel_created`, `style.channel_updated`, `sku.channel_created`, `sku.channel_linked`, and `sku.channel_updated` as the caller's `system_job` actor with before and after of the changed fields only. Every code has its registry entry with English and Arabic labels and a proof test.
- **AC-18** (screens): `/skus`, `/skus/[id]`, `/styles`, `/styles/[id]`, `/seasons`, and `/product-groups` work in English and Arabic with no hard coded text and logical CSS only, follow `packages/ui/DESIGN.md` (data tables collapse to cards below 640px, codes in `LtrText`, amounts and dates through `useFormat()`), have exactly one `<h1>`, loading, empty, and error states, are usable by keyboard alone to WCAG 2.2 AA, and show the no access state for a person without the page's permission. Seasons and Product groups appear in the navigation for `catalog.manage`, Styles for `stock.view`. A Shopify owned field shows read only with "From Shopify".

## Decision

**Chosen option**: Option 1 in [rationale.md](rationale.md): one normalized `search_text` column per variant kept by database triggers, served by one trigram GIN index, with barcode and code prefix branches beside it; style, season, and group screens on the existing catalog module; and a catalog owned `CatalogChannelSync` service that matches by the ids the connector passes, then by SKU code, never reading the connector's tables.

**Implementation skills**: `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `tanstack-query` (`tanstack-skills/tanstack-skills`, `.claude/skills/tanstack-query/`) · `react-hook-form-zod` (`secondsky/claude-skills`, `.claude/skills/react-hook-form-zod/`) · `shadcn` (`.claude/skills/shadcn/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### What is built today (the starting point)

- `packages/db/src/schema/catalog.ts`: `products` (a style: `style_code` unique per tenant, `season_id` null, `product_group_id`, `name jsonb`, `status`, `tags`, `archived_at`), `product_options` (`name`, `position`, `values jsonb`), `product_variants` (`sku` unique per tenant, `option_values jsonb`, `kind`, `tracking`, `price`, `archived_at`), `barcodes` (`code` unique per tenant, `uom_id`), `seasons` and `product_groups` (no timestamps), `cost_records` (append only). Search indexes: `products_search_trgm_idx` (an expression the query never matches, so the name branch scans; spec 0002 Follow-up), `product_variants_sku_c_idx`, `product_variants_sku_trgm_idx`.
- `apps/api/src/catalog/`: `CatalogService` (one variant products, SKU list with a code prefix plus name `ILIKE` union, edit, `setCode`, `setArchived` that archives the product with any variant, `deleteSku`, `getSkus`, `checkStockable`), `CostService.costFor`, `CatalogController` (`POST /products`, `GET /skus`, `GET`/`PATCH`/`DELETE /skus/:id`).
- `apps/web/src/catalog/`: the SKU list and detail pages with create and edit dialogs. No style, season, or group screen exists.

### Modules and ownership

- `apps/api/src/catalog/` stays the only owner of the catalog tables. New folders by feature: `search/` (the SQL builders for `/skus` and `/styles`), `styles/` (`StylesService`, `StylesController`), `seasons/`, `product-groups/`, `barcodes/` (service and routes under `/skus/:id/barcodes`), `cost-records/` (controller over `CostService`), `channel-sync/` (`CatalogChannelSync`, exported). `CatalogModule` exports `CatalogService`, `CostService`, and `CatalogChannelSync`. Catalog still imports nothing from inventory; it imports `AuditModule` and the platform settings reader.
- `packages/contracts/src/catalog/` (the existing `catalog.ts` moves into this folder with an `index.ts` re-export): `search.ts`, `styles.ts`, `seasons.ts`, `product-groups.ts`, `barcodes.ts`, `cost-records.ts`, `channel-product.ts`, `option-roles.ts`.
- `apps/web/src/catalog/` gains `styles/`, `seasons/`, `product-groups/` subfolders (each with a README); routes `(backoffice)/styles/page.tsx`, `styles/[id]/page.tsx`, `seasons/page.tsx`, `product-groups/page.tsx`.
- Inventory's `sku-lifecycle` keeps calling `CatalogService.setArchived` and `setCode`; only their catalog side changes (AC-11).

### Data model sketch

Every table keeps `tenant_id`; every unique key below leads with it. No new table.

| Table | Change | Constraints and indexes |
|---|---|---|
| `product_variants` | add `search_text text not null default ''` (kept by triggers, AC-2); add `channel_linked_at timestamptz null` (set while a channel owns some fields, AC-15) | GIN `product_variants_search_trgm_idx` on `search_text gin_trgm_ops`; partial unique `product_variants_options_unique` on (`tenant_id`, `product_id`, `option_values`) where `archived_at IS NULL` (AC-10); drop `product_variants_sku_trgm_idx` (the new index covers code fragments); keep `product_variants_sku_c_idx` |
| `products` | add `channel_linked_at timestamptz null`; add `channel_name_language text null` | check `channel_name_language IN ('en', 'ar')`; drop `products_search_trgm_idx` (replaced by the variant column) |
| `product_options` | add `role option_role not null default 'other'`, new enum `option_role` (`size`, `color`, `other`) | backfilled from the name by the AC-10 rule in the migration |
| `barcodes` | add `from_channel boolean not null default false` (the one barcode per variant the sync manages) | partial unique on (`tenant_id`, `variant_id`) where `from_channel` (at most one channel barcode per variant) |
| `seasons`, `product_groups` | add `created_at` and `updated_at` (`timestamptz not null default now()`), closing spec 0002 Follow-up R15 | unchanged |

Functions and triggers (a custom migration, schema qualified names, plpgsql bodies with `SET search_path = pg_catalog, public, pg_temp`; `ssd_search_normalize` is plain `sql` without `SET` so it inlines, like `ssd_operating_day`):
- `ssd_search_normalize(text)`: AC-1, written with `lower`, `translate`, and `regexp_replace` only (all immutable).
- `ssd_variant_search_text(product_id uuid, sku text, option_values jsonb) RETURNS text`: reads `public.products` and `public.product_options` and returns the normalized document of AC-2.
- `product_variants_search_text` `BEFORE INSERT OR UPDATE OF sku, option_values, product_id ON product_variants`: sets `NEW.search_text`.
- `products_search_text_follows` `AFTER UPDATE OF name, style_code ON products` and `product_options_search_text_follows` `AFTER INSERT OR UPDATE OR DELETE ON product_options`: `UPDATE public.product_variants SET search_text = ...` for that style's variants only, never touching `updated_at`.
- The migration backfills `search_text` for every variant in SQL, then builds the index.

Relationships are unchanged: a style has 1 to N variants (spec 0006's one variant limit is lifted by `POST /styles/:id/variants`), 0 to 3 options, one group, 0 or 1 season; a variant has 0 to N barcodes; cost records stay keyed to style and season with an optional variant override (composite key to `(id, product_id)`).

### Field ownership (channel linked records, AC-15)

A style or variant is channel linked while its `channel_linked_at` is set. "Source store" means the store named by the setting `catalog.source_store_id`, or any store while that setting is null (owner decision Q-12.3, recommended).

| Field | Owner | Sync rule |
|---|---|---|
| Style name, in the language of the channel title's script (`channel_name_language`: `ar` when the title has an Arabic letter, else `en`) | Shopify, source store | overwritten when the title changes; the app refuses edits to that language |
| Style name, the other language | app | never touched by the sync |
| Style code | app | seeded at creation from the handle (Q-12.1), never changed by the sync |
| Season, product group | app | seeded at creation from the settings requested from feature 9, never changed by the sync |
| Description, tags written by staff | app for description; Shopify for tags | description is not synced; tags are replaced from the source store |
| Product type, vendor (`brand`) | Shopify, source store | overwritten when changed |
| Style archive, status | app | the sync never archives, unarchives, or changes `status` (Shopify's draft or archived state is the connector's concern, spec 0015) |
| Option names, option values, a variant's option values | Shopify | names set when the option is created; new values appended; a variant's values follow Shopify, `option_conflict` when that would duplicate another active variant's values |
| Option role | app | inferred at creation (AC-10), editable later only by a future screen |
| SKU code | app after creation | a different SKU from Shopify on a linked variant answers `sku_mismatch`, nothing changes |
| Price, compare at price | Shopify, source store | overwritten when changed; the app refuses price edits on a linked variant |
| Weight in grams, requires shipping | Shopify, source store | overwritten when changed |
| The channel barcode (`from_channel`) | Shopify, source store | added, replaced, or removed to follow Shopify's one barcode; a code another variant holds answers `barcode_conflict` and is not applied; barcodes added in the app are never touched |
| Kind | app | seeded at creation (`stocked`, or `service` when Shopify does not track inventory) |
| Tracking, base unit, dimensions, HS code, country of origin, custom fields | app | never touched |
| Cost records | app | never from a channel |

### The channel upsert contract (for spec 0015)

`ChannelProductInput` (Zod in `packages/contracts/src/catalog/channel-product.ts`; the connector maps Shopify's payload to it, and spec 0015 owns that mapping, the webhook, the backfill, and the map from Shopify ids to catalog ids in `connection_external_ids`):

```ts
{
  storeId: uuid,                       // the store this product came from; source store and group lookups
  externalProductId: string,           // for the audit entry only; catalog never stores it
  styleId: uuid | null,                // what the connector's map says, null when unmapped
  handle: string,                      // style code seed (Q-12.1)
  title: string,                       // 1 to 200 characters
  productType: string | null, vendor: string | null, tags: string[],
  options: { name: string, values: string[] }[],   // 0 to 3; Shopify's lone "Title" / "Default Title" is sent as []
  variants: {
    externalVariantId: string,
    variantId: uuid | null,            // from the connector's map
    sku: string | null,
    optionValues: string[],            // by option position
    price: MoneyString | null, compareAtPrice: MoneyString | null,
    barcode: string | null, weightGrams: number | null,
    requiresShipping: boolean, tracked: boolean,
  }[]                                  // 1 to 2,048 (Shopify's variant limit per product, confirmed on shopify.dev by spec 0015)
}
```

`ChannelProductResult`: `{ styleId: uuid | null, styleOutcome: 'created' | 'updated' | 'unchanged', variants: { externalVariantId, variantId: uuid | null, outcome: 'created' | 'linked' | 'updated' | 'unchanged' | 'needs_sku' | 'invalid_sku' | 'sku_mismatch' | 'barcode_conflict' | 'option_conflict' }[] }`. `linked` means an existing catalog variant (made by hand, by an import, or by another store) now carries this channel's data. A conflict outcome still returns the variant id when one was resolved, so the connector can map it, and the connector decides whether to open a task (feature 17). `styleId` is null only when every variant was refused.

Rules inside `applyProduct`, in one transaction the caller owns:
1. Take one transaction advisory lock on the hash of `catalog.channel_style:` plus the normalized handle, so two stores' webhooks for the same product queue instead of racing (one lock per call, never one per variant).
2. Resolve each variant (AC-14). Insert new variants with `ON CONFLICT (tenant_id, sku) DO NOTHING RETURNING id`; no row back means another writer created it, so re read it and treat it as `linked`.
3. Create a new style only when the first variant must be created. Its code is the handle uppercased, every character outside `[A-Z0-9._-]` turned into `-`, cut to 60 characters; on a clash `-2`, `-3` and so on are appended (`ON CONFLICT DO NOTHING` and retry). If the style ends the call with no variant, delete it before returning.
4. Compare before writing: an `UPDATE ... WHERE (fields) IS DISTINCT FROM (new values)` changes nothing and writes no audit entry when Shopify's data equals what is stored. Set `channel_linked_at` (first link only) on every resolved variant and its style.
5. Write the audit entries of AC-17 for what changed, with the caller's actor and one correlation id from `AuditService.newCorrelationId(actor)`.

### Search (AC-3, AC-8)

`buildSkuListSql(query, words)` in `catalog/search/`: the api first runs `SELECT ssd_search_normalize($q)` (the same function the column uses, so the query and the index agree), splits the result on spaces, keeps the first 5 distinct words, and builds the three branch union. Branch (c) runs only when at least one word has 3 or more characters, because a shorter pattern gives the trigram index nothing to look up. Filters (`seasonId`, `none`, `productGroupId`, `styleId`, `status`) go into every branch. The keyset stays the SKU code (`COLLATE "C"`). `/styles` reuses the same words with an `EXISTS` over the style's variants plus the style code prefix.

### API surface

All under `/api`, `@Audience('staff')`, bodies and queries as Zod schemas in `packages/contracts`, errors mapped by `catalogHttpError` (new codes below). Lists use the keyset convention.

| Endpoint | Method | Key inputs | Key outputs | Permission | Key errors |
|---|---|---|---|---|---|
| `/skus` | GET | `q?` (1 to 100), `status?`, `seasonId?` (uuid or `none`), `productGroupId?`, `styleId?`, `cursor?`, `limit?` (≤ 50) | `items: SkuSummary[]` (adds `style {id, code, name}`, `season {id, code, name} \| null`, `productGroup {id, code, name}`, `options [{name, value}]`), `nextCursor` | `stock.view` | 400 `INVALID_QUERY` |
| `/skus/:id` | GET | id | `SkuDetail` (adds the AC-4 fields, `barcodes [{id, code, fromChannel}]`, `channelLinked`) | `stock.view` | 404 |
| `/skus/:id` | PATCH | unchanged (spec 0006) | `SkuDetail` | `catalog.edit` | 409 `FIELD_OWNED_BY_CHANNEL` (price on a linked variant), `STALE_RECORD`; 404 |
| `/skus/:id/barcodes` | POST | `code` (req) | `SkuDetail` | `catalog.edit` | 409 `BARCODE_TAKEN` (with `skuCode`); 400 `INVALID_INPUT`; 404 |
| `/skus/:id/barcodes/:barcodeId` | DELETE | ids | 204 | `catalog.edit` | 404 |
| `/products` | POST | spec 0006 fields plus `styleCode?`, `seasonId?`, `productGroupId?` | `SkuDetail` | `catalog.edit` | 409 `SKU_TAKEN`, `STYLE_CODE_TAKEN`; 422 `ARCHIVED` |
| `/styles` | GET | `q?`, `status?`, `seasonId?` (or `none`), `productGroupId?`, `cursor?`, `limit?` (≤ 50) | `items: StyleSummary[]`, `nextCursor` | `stock.view` | 400 |
| `/styles/:id` | GET | id | `StyleDetail`; each variant carries `cost` (`{ status: 'set', unitCost, costBasis, effectiveFrom, inheritedFrom: 'style' \| 'variant' } \| { status: 'not_set' }`) only for `cost.view` | `stock.view` | 404 |
| `/styles/:id` | PATCH | `updatedAt` (req), `name?`, `description?` (nullable), `seasonId?` (nullable), `productGroupId?`, `tags?` | `StyleDetail` | `catalog.edit` | 409 `STALE_RECORD`, `FIELD_OWNED_BY_CHANNEL`; 422 `ARCHIVED`; 404 |
| `/styles/assign` | POST | `styleIds` (1 to 200, distinct), `seasonId?` (nullable), `productGroupId?` (at least one of the two) | `{ updated: number }` | `catalog.edit` | 404 `NOT_FOUND` (with `missingIds`); 422 `ARCHIVED`, `INVALID_INPUT` |
| `/styles/:id/code` | PATCH | `updatedAt`, `code` | `StyleDetail` | `catalog.manage` | 409 `STYLE_CODE_TAKEN`, `STALE_RECORD`; 404 |
| `/styles/:id/variants` | POST | `sku` (req), `options [{name, value}]` (0 to 3), `price?`, `barcode?` | `SkuDetail` | `catalog.edit` | 409 `SKU_TAKEN`, `OPTION_COMBINATION_TAKEN`, `BARCODE_TAKEN`; 422 `TOO_MANY_OPTIONS`, `ARCHIVED` (archived style); 404 |
| `/styles/:id/cost-records` | GET | `cursor?`, `limit?` (≤ 50) | `items [{id, variant {id, code} \| null, season {id, code}, costBasis, unitCost, effectiveFrom, source, recordedAt, recordedBy {id, name} \| null}]`, `nextCursor` | `stock.view` + `cost.view` | 403; 404 |
| `/styles/:id/cost-records` | POST | `variantId?`, `seasonId` (req), `costBasis` (req), `unitCost` (req, 4 decimals), `effectiveFrom` (req, `YYYY-MM-DD`), `source?` (≤ 200), `reason?` (≤ 500) | the new record plus the style's variant costs | `catalog.edit` + `cost.view` | 422 `REASON_REQUIRED`, `INVALID_INPUT`; 403; 404 |
| `/seasons`, `/product-groups` | GET | `status?`, `q?`, `cursor?`, `limit?` (≤ 100) | `items` (id, code, name, dates for seasons, archived, `updatedAt`), `nextCursor` | `stock.view` | 400 |
| `/seasons`, `/product-groups` | POST | `code`, `name`, `startsOn?`, `endsOn?` (seasons) | the row | `catalog.manage` | 409 `SEASON_CODE_TAKEN` / `PRODUCT_GROUP_CODE_TAKEN`; 422 `INVALID_INPUT` |
| `/seasons/:id`, `/product-groups/:id` | PATCH | `updatedAt` (req), `code?`, `name?`, dates | the row | `catalog.manage` | 409 `STALE_RECORD`, the code taken code, `SEASON_PROTECTED` / `PRODUCT_GROUP_PROTECTED` (recoding a seeded row); 404 |
| `/seasons/:id/archive` · `/unarchive` (and the same for groups) | POST | id | the row | `catalog.manage` | 409 the protected code; 404 |
| `/seasons/:id`, `/product-groups/:id` | DELETE | id | 204 | `catalog.manage` | 409 `IN_USE`, the protected code; 404 |

Internal (exported, no route): `CatalogChannelSync.applyProduct(tx, input, actor)`, `CatalogChannelSync.unlink(tx, { styleIds, variantIds })`, `CostService.costForMany(variantIds, onDay)`. Also exported, added by spec 0011 (task 9, AC-18): `CatalogService.lockForShare` and `CatalogService.lockForUpdate` on variant rows, so the ledger and reconciliation stop reading `product_variants` directly; this spec does not change them.

### Audit (AC-17)

| Code | Record type | Reason | Auto | Undo |
|---|---|---|---|---|
| `style.edited` (name, description, season, group, tags; one per style on a bulk assign) | `style` | o | no | no |
| `style.code_changed` | `style` | o | no | no |
| `style.variant_added` | `style` | o | no | no |
| `sku.barcode_added`, `sku.barcode_removed` | `sku` | o | no | no |
| `cost_record.recorded` (record id = the style) | `style` | o; R when backdated (`reasonRequired: true`) | no | no |
| `season.created`, `season.edited`, `season.archived`, `season.unarchived`, `season.deleted` | `season` | o | no | no |
| `product_group.created`, `product_group.edited`, `product_group.archived`, `product_group.unarchived`, `product_group.deleted` | `product_group` | o | no | no |
| `style.channel_created`, `style.channel_updated`, `sku.channel_created`, `sku.channel_linked`, `sku.channel_updated` | `style` or `sku` | not applicable | yes | no (Shopify would write it back on the next sync) |

New record types in `AUDIT_RECORD_TYPES`: `style` (label pattern `SKU_CODE_PATTERN`, the style code), `season` and `product_group` (label pattern `^[A-Z0-9._-]{1,16}$`), no personal keys, free text reasons. Creating a SKU or a style by hand stays unaudited, as in spec 0006.

### Settings requested from feature 9

Registry entries in `packages/contracts/src/settings/` (group "Catalog", bundle `core`, `whoMayChange: settings.manage`, exposure `staff`, reason optional except `catalog.store_product_groups`, which needs a reason), read through `SettingsService`; the rows are exactly spec 0009's *Rows requested by specs 0012 to 0015*, which wins where the two differ. `catalog.store_product_groups` carries the `warning` "new styles first created from that store get this group, which decides their accounting export code", because the product group is an axis of the accountant's export rules (spec 0009 wave 1 review W17). The settings screen shows the three keys with their value and default and a "set on the connection or catalog pages" note until their pickers exist (stores from spec 0015's connections, seasons and product groups from this spec); the feature that owns each list adds the editor in its build. Until the entries exist, `CatalogChannelSync` behaves as with their defaults.

| Key | Value | Default | Used for |
|---|---|---|---|
| `catalog.source_store_id` | store id or null | null (every store's content applies) | the store whose Shopify content the catalog keeps (Q-12.3) |
| `catalog.store_product_groups` | map of store id to product group code | `{}` | the group of a style first created from that store; a missing, unknown, or archived group gives `MAIN` |
| `catalog.new_style_season` | season code or null | null | the season of a style first created from a channel; unknown or archived gives none |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| any search | normalized words | `ssd_search_normalize(q)` in SQL, split on spaces in the api, first 5 distinct |
| any search | barcode to match | q trimmed, digits through `normalizeDigits` (`@ssdashboard/i18n`, used by `packages/contracts/src/digit-input.ts`), uppercased |
| any search | code prefix | q through `normalizeDigits`, uppercased, `LIKE` escaped |
| SKU row | style, season, group | `products` joined by `product_id`, `seasons` and `product_groups` by their ids |
| SKU row | option name and value | `product_options.name` and `values[option_values[position]]` |
| style list | active variant count | `count(*)` of its variants with `archived_at IS NULL` |
| style page | cost in force | `CostService.costForMany(ids, ssd_operating_day(now()))` |
| style page | inherited or override | the chosen cost record's `variant_id` (null means `style`) |
| style page | "estimate" label | the record's `cost_basis = 'estimate'` |
| record cost | today, for the backdating rule | `ssd_operating_day(now())` |
| record cost | `recorded_by` | the session user id |
| any audit entry | actor and hat | `Access.actingHat` for a person; the caller's actor for the sync |
| any audit entry | record label | the style code, SKU code, season code, or group code |
| add variant | option match | names and values compared after `ssd_search_normalize` |
| add variant | option role | the AC-10 name list (`OPTION_ROLE_NAMES` in contracts) |
| add variant | base unit | the seeded `pc` unit, kind `stocked`, tracking `none` |
| `POST /products` | style code default | the SKU code (spec 0006) |
| channel apply | new style code | the handle (Q-12.1), shaped and de duplicated as in rule 3 |
| channel apply | new style group | setting `catalog.store_product_groups[storeId]`, else `MAIN` |
| channel apply | new style season | setting `catalog.new_style_season`, else none |
| channel apply | content applies? | `catalog.source_store_id` is null or equals `input.storeId` |
| channel apply | name language | `channel_name_language`, set at first link from the title's script |
| channel apply | new variant kind | `stocked` when `tracked`, else `service` |
| app edits | Shopify owned? | `channel_linked_at IS NOT NULL` on the variant (price) or style (`channel_name_language`) |
| archive a SKU | archive the style too? | no other variant of the style with `archived_at IS NULL` |
| every list | stale check value | `updated_at` as the microsecond UTC string (spec 0006) |

### Key invariants

- Only the catalog module writes catalog tables; the channel sync writes them only through `CatalogChannelSync`, which never reads connector or channel tables.
- `search_text` always equals its recomputation; the database keeps it, not application code.
- A SKU code is never changed by a channel; a code changes only through inventory's code change route (spec 0006 AC-2, locked once stock posted).
- The sync never archives, unarchives, or deletes, and never writes a field the app owns.
- No 0 stands in for a missing cost; "Not set" is a state.
- Cost records are only added (spec 0002 A4); no route edits or deletes one.

### Security model

Staff audience only; permissions per AC-16, no new permission (requested from feature 8: none). Cost fields follow `cost.view` through the response serializer on `Access`, with `cost` added to `COST_FIELD_KEYS` so the sweep catches a leak. No personal data is stored or logged by this feature (catalog data is not personal); free text audit reasons go through the existing phone and email masking.

### Configuration required

None. No new environment variable; the three settings above come from feature 9.

### Migration plan

**Strategy**: forward only, expand in place. Each milestone that needs schema adds one migration (a generated file for columns and indexes, a `--custom` file for functions, triggers, backfills, and the enum backfill). The search migration adds `search_text` with a default, backfills it in SQL, then creates the index and drops the two old trigram indexes in the same release, since the new query no longer uses them and no data is lost. **Rollback**: a new forward migration; the old indexes can be recreated from spec 0002's definitions. **Risks**: the backfill and index build hold locks for seconds at 50,000 variants, acceptable before the pilot and inside the upgrade window after it.

### Critical test scenarios

- Normalization fixtures and the trigger recomputation test, verifies **AC-1**, **AC-2**
- Search: hamza free Arabic, Arabic digits, two words in reverse order, a hyphenated code fragment, exact barcode, one letter query, `%` in q, archived filter, season `none` filter, verifies **AC-3**, **AC-4**
- Scale: the six reads under 150 ms with their plans, verifies **AC-5**
- Seasons and groups: create, recode, stale edit, archive then assign (422), delete in use (409), `CORE` and `MAIN` protected, verifies **AC-6**, **AC-7**
- Styles: list filters, bulk assign of 3 styles with one unknown id (nothing changes), code clash, add a second and third variant with a new color option, duplicate combination (409), barcode taken by another SKU (409 naming it), verifies **AC-8**, **AC-9**, **AC-10**
- Archive the second of two variants: the style stays active; archive the last: the style is archived; unarchive one: the style is active, verifies **AC-11**
- Cost: style record SS26, variant override, a backdated record without a reason (422), with one (saved), "Not set" on a new style, `costForMany` equal to `costFor` for every id, verifies **AC-12**, **AC-13**
- Channel: a fixture product applied twice (second all `unchanged`, no audit rows), a Default Title product, an Arabic title, a variant without SKU, a SKU that already exists by hand (`linked`), the same product from two stores in parallel (one style, one set of variants), a price change from a non source store (ignored), a SKU change on a linked variant (`sku_mismatch`), verifies **AC-14**, **AC-15**
- Auth: the route sweep as each hat; a warehouse person without `cost.view` gets no `cost` key and 403 on cost records, verifies **AC-16**
- Audit: every code's proof test; bulk assign writes 3 entries with one correlation id, verifies **AC-17**
- Screens: Playwright in both languages, keyboard only, axe clean, phone width cards, verifies **AC-18**

## Build plan

Tracer Bullet: milestone 1 runs the search through every layer (SQL function, column, trigger, index, contract, api, screen, scale suite), because "find any variant fast" is the feature's done when. Each later milestone thickens one segment end to end: the master data screens, then cost, then the channel contract that spec 0015 builds on. Each milestone is one commit; schema lands in the milestone that first needs it.

**Milestone 1: Search through every layer**
1. [ ] Custom migration: `ssd_search_normalize`, `ssd_variant_search_text`, `product_variants.search_text` with the three triggers, the SQL backfill, `product_variants_search_trgm_idx`, and the drop of `products_search_trgm_idx` and `product_variants_sku_trgm_idx`; Drizzle schema updated; `packages/db/test/search-normalize.e2e-spec.ts` with the fixture table and the recomputation test, satisfies **AC-1**, **AC-2**
2. [ ] Contracts: `SkuListQuery` filters, the wider `SkuSummary` and `SkuDetail`, the move of `catalog.ts` into `catalog/`, satisfies **AC-3**, **AC-4**
3. [ ] Api `catalog/search/`: the three branch `buildSkuListSql` with filters and the joined row fields, `GET /skus/:id` with barcodes; unit tests of the builder; `test/master-data.e2e-spec.ts` search cases, satisfies **AC-3**, **AC-4**
4. [ ] Web: `/skus` columns, the "Name, SKU or barcode" search, season and group filters, the SKU page's style block with barcodes (read only), both languages, satisfies **AC-4**, **AC-18**
5. [ ] Scale: `scale-seed.ts` gives every style English and Arabic names, every variant size and color values and one barcode; `scale.e2e-spec.ts` asserts the six reads and their indexes; measured p95 recorded in `verify.md`, satisfies **AC-5**

**Done when** `pnpm build && pnpm typecheck && pnpm test` pass, `pnpm --filter @ssdashboard/db test:e2e -- test/search-normalize.e2e-spec.ts` and `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/master-data.e2e-spec.ts` pass, and `pnpm --filter @ssdashboard/api test:scale` shows the six search reads under 150 ms with their plans.

**Milestone 2: Seasons, product groups, and styles**
6. [ ] Migration: timestamps on `seasons` and `product_groups`, the `option_role` enum and column with the name backfill, `product_variants_options_unique`, satisfies **AC-6**, **AC-7**, **AC-10**
7. [ ] Audit registry codes and the `style`, `season`, `product_group` record types with English and Arabic labels in `packages/i18n`, satisfies **AC-17**
8. [ ] Api `seasons/` and `product-groups/`: list, create, edit with stale check, archive, unarchive, delete with `IN_USE`, `CORE` and `MAIN` protection, audit entries, satisfies **AC-6**, **AC-7**, **AC-17**
9. [ ] Api `styles/` and `barcodes/`: list, detail, edit, bulk assign, code change, add variant with option matching and roles, the `POST /products` optional fields, barcode add and remove; `setArchived` archives the style only with its last active variant, satisfies **AC-8**, **AC-9**, **AC-10**, **AC-11**, **AC-17**
10. [ ] Route sweep fixtures and `@Permission` on every new route, satisfies **AC-16**
11. [ ] Web: `/styles` (filters, multi select with "Set season" and "Set group"), `/styles/[id]` (edit dialog, code dialog, add variant dialog, barcodes), `/seasons`, `/product-groups`, navigation entries, satisfies **AC-6**, **AC-7**, **AC-8**, **AC-9**, **AC-10**, **AC-18**
12. [ ] Tests: `test/styles.e2e-spec.ts`, `test/seasons-groups.e2e-spec.ts`, the archive cases in `test/master-data.e2e-spec.ts`, `apps/web/e2e/styles.spec.ts` (both languages, keyboard, axe, phone width), satisfies **AC-6** to **AC-11**, **AC-17**, **AC-18**

**Done when** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` pass, `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/styles.e2e-spec.ts test/seasons-groups.e2e-spec.ts test/master-data.e2e-spec.ts test/access-sweep.e2e-spec.ts` passes, and `pnpm --filter @ssdashboard/web test:e2e -- e2e/styles.spec.ts` passes.

**Milestone 3: Inherited cost, visible and recordable**
13. [ ] `CostService.costForMany` (one query, same rule as `costFor`, plus `inheritedFrom`); `cost` in `COST_FIELD_KEYS`; the `StyleDetail` serializer on `Access`, satisfies **AC-12**, **AC-16**
14. [ ] `cost-records/` controller: list and add with the backdating reason rule and `cost_record.recorded`, satisfies **AC-13**, **AC-17**
15. [ ] Web: the cost column on the style page (inherited, override, estimate, Not set), the cost history panel, the record cost dialog, hidden without `cost.view`, satisfies **AC-12**, **AC-13**, **AC-18**
16. [ ] Tests: `test/cost.e2e-spec.ts` extended (many equals one, backdating, 403 and no `cost` key without the grant), the sweep fixtures, the web e2e cost steps, satisfies **AC-12**, **AC-13**, **AC-16**

**Done when** `pnpm test` passes and `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/cost.e2e-spec.ts test/access-sweep.e2e-spec.ts` passes, and the style page shows an inherited cost, an override, and "Not set" for a cost holder and no cost for a warehouse person.

**Milestone 4: The channel upsert contract**
17. [ ] Migration: `channel_linked_at` on styles and variants, `channel_name_language`, `barcodes.from_channel` with its partial unique index, satisfies **AC-15**
18. [ ] Contracts: `ChannelProductInput`, `ChannelProductResult`, `OPTION_ROLE_NAMES`; the three settings registry entries when feature 9's registry has landed, else a `CatalogSettings` reader returning their defaults, satisfies **AC-14**, **AC-15**
19. [ ] `catalog/channel-sync/`: `applyProduct` (lock, resolve, create, compare, link, audit) and `unlink`; exported from `CatalogModule`, satisfies **AC-14**, **AC-15**, **AC-17**
20. [ ] `FIELD_OWNED_BY_CHANNEL` on the price of a linked variant and the channel language of a linked style's name; "From Shopify" read only fields on the SKU and style pages, satisfies **AC-15**, **AC-18**
21. [ ] Tests: `test/channel-sync.e2e-spec.ts` on recorded style fixtures (applied twice, Default Title, Arabic title, missing SKU, hand made SKU linked, two stores in parallel, non source store, SKU mismatch, barcode conflict, option conflict); the README of `apps/api/src/catalog/` names the contract for spec 0015, satisfies **AC-14**, **AC-15**, **AC-17**

**Done when** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` pass and `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/channel-sync.e2e-spec.ts` passes, including the parallel two store case and the idempotent second run with no audit rows.

## Consequences

**Positive**:
- One normalized column and one index answer name, code, and option searches in both languages, so search stays fast as the catalog grows and every later picker (receipts, orders, exchanges, scanning) reuses it.
- The brand's own vocabulary (style, season, product group, size, color) is on every SKU row, and cost inheritance is visible instead of implied.
- Spec 0015 gets a stable, idempotent catalog contract with written field ownership, so a resync cannot duplicate SKUs or erase the brand's Arabic names, seasons, and groups.

**Negative / tradeoffs**:
- Triggers keep a denormalized copy of style names on each variant; a style rename updates every variant row of that style and waits behind any posting that holds those rows `FOR SHARE`.
- Words shorter than 3 characters do not search names (only the barcode and code prefix branches run), so `m` alone finds codes starting with `M`, not every medium size.
- A Shopify title in one language owns only that language slot; a brand that writes mixed language titles gets the whole title in the Arabic slot.
- One style per Shopify product (Q-12.4) means a brand that lists each color as its own Shopify product prices each color style separately; grouping colors into one style needs a later tool.
- Price follows one source store (Q-12.3), so a second store's different price is not kept in the catalog.

**Neutral**:
- `SkuSummary` grows; the receipt picker and other readers ignore the new fields.
- The old trigram indexes are dropped in the same release as the new one is built.
- Spec 0007's search line names `simple` full text search; this spec does not add it (see rationale).

## Questions for the owner

Each is decided in this spec with the recommended answer, so the build can start; a different answer changes only the rows named.

1. **Q-12.1 Style code of a style first created from Shopify.** Shopify has no style code. *Recommended: the product's handle, uppercased and shaped to the code pattern, editable afterwards by `catalog.manage`.* Alternatives: the longest shared prefix of its variants' SKU codes (fails when SKUs share none); the Shopify product id (opaque to staff). Changes AC-14 and channel rule 3.
2. **Q-12.2 A Shopify variant with no SKU.** *Recommended: refused as `needs_sku` (the connector opens a task to set a SKU in Shopify), because a code locks once stock posts and is printed on labels and partner sheets.* Alternative: generate `SHP-<variant id>` so orders flow at once, at the price of permanent machine codes. Changes AC-14.
3. **Q-12.3 Two stores selling the same SKU at different prices.** *Recommended: one source store setting (`catalog.source_store_id`); its content wins, others only link; orders keep their own line prices anyway.* Alternatives: a per store price table in the catalog (more to build, needed only if exchanges must value by store); last write wins (prices flip with every sync). Changes AC-15 and the settings table.
4. **Q-12.4 One style listed as several Shopify products (one per color).** *Recommended: one Shopify product is one style, matching the reference brand, whose style already carries one color (`products.colour`); a grouping tool comes later if a brand needs one style across colors.* Alternative: build a merge that moves products into one style with a color option now (option axis remapping, cost record rules, connector map updates). Changes AC-14 and spec 0002's catalog child (amended).
5. **Q-12.5 Who may record a cost by hand.** *Recommended: `catalog.edit` plus the `cost.view` grant, since the manager already chooses who holds the grant.* Alternative: `catalog.manage` plus `cost.view` (the manager alone). Changes AC-13 and AC-16.

## Follow-up

- [ ] Spec 0015: map Shopify's payload to `ChannelProductInput` (weight units to grams, the Default Title option to `[]`, gift cards skipped), keep `connection_external_ids`, call `unlink` when a connection or a Shopify variant goes, open tasks for `needs_sku`, `sku_mismatch`, `barcode_conflict`, `option_conflict`, and own the Shopify listing state (active, draft, archived).
- [x] Taken by spec 0011 (task 9, AC-18): a catalog locking method (`CatalogService.lockForShare` and `lockForUpdate` on variant rows) so the ledger and reconciliation stop reading `product_variants` directly (`KNOWN_BREACHES` in `apps/api/src/module-boundary.spec.ts`).
- [ ] Feature 9: register the three catalog settings and show them in a Catalog section.
- [ ] Feature 8 (spec 0008): the matrix text of `catalog.manage` should also say "manage seasons and product groups, change style codes" (no new permission).
- [ ] Feature 20: a scan endpoint can reuse the barcode branch (`barcodes_code_unique`) for an exact lookup.
- [ ] Feature 40: channel codes and aliases may join the search as a fourth branch.
- [ ] Features 24 and 46: the reference brand's `model` grouping (one model across color styles) for reports, as a custom field or a later attribute.
- [ ] A grouping tool for one style across several Shopify products, if a pilot brand needs it (Q-12.4).
- [ ] `packages/contracts/src/catalog.ts` TSDoc "One variant for now; feature 8 lifts the limit" becomes false with milestone 2; the build fixes it.
