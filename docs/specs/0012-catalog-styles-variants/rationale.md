# 0012. Catalog, styles and variants: rationale

The decision record behind [index.md](index.md). `/develop` builds from the index; this file says why.

## Context

Scope feature 12 asks for products as an Egyptian clothing brand thinks of them: a style, its season and product group, and its variants by size and color, mostly arriving from Shopify. Its done when is concrete: staff find any variant by name, SKU, or barcode, in Arabic or English, in well under a second at 10,000 SKUs (tested at 50,000), see its style, season, and group, and every variant inherits its style's cost unless overridden.

Most of the data model is already built. Spec 0002's amendment (A12) made a product a style with `style_code`, `season_id`, and `product_group_id`, added `seasons` (seeded `CORE`), `product_groups` (seeded `MAIN`), and append only `cost_records`, and built `CostService.costFor`, which already returns a variant override before its style's record and "not set" instead of 0 (`apps/api/src/catalog/cost.service.ts`, `cost-selection.ts`). Spec 0006 built a one variant create path, SKU edit, archive, delete, and a list whose search is a code prefix branch plus a name `ILIKE` branch (`buildSkuListSql` in `apps/api/src/catalog/catalog.service.ts`). What is missing is everything a person touches: no screen shows a style, a season, or a group; nothing adds a second size to a style; cost inheritance is invisible; and search is not ready for the target.

Search is the load bearing gap. The scale suite of spec 0002 measured that the name branch scans `products`, because its `ILIKE` on `name->>'en'` and `name->>'ar'` does not match the indexed expression (spec 0002 Follow-up, "Feature 12: replace the trigram expression index"). It was fast at 5,000 styles only because the table is small. Arabic typing makes it worse: the same word is typed with or without hamza (`أسود`, `اسود`), with `ى` or `ي`, with `ة` or `ه`, with diacritics, with Arabic Indic digits, and staff search for "black tee" when the style is "Tee" and the color option is "Black". Spec 0007 section 11 leaves the Arabic rules to this feature and requires that normalization be a SQL function, so the index and the query agree.

The second force is Shopify. Feature 13 (spec 0015, written in parallel) will create and update products from one or several stores of one brand. The module wall (root `AGENTS.md`, Rules) forbids the connector from writing catalog tables, and the catalog from reading the connector's `connection_external_ids` (spec 0002 orders child, feature 13). Without a written catalog contract and a field ownership rule, a resync either duplicates SKUs (two stores, one SKU) or overwrites what the brand typed in the app (the Arabic name, the season, the group). The reference brand (the reference console, read only) runs two Shopify stores with two product groups, matches every channel line to a canonical variant by SKU code, and keeps style level attributes `model` and `colour` (`supabase/migrations/20260925120000_product_attributes.sql`), so one Shopify product there is one style in one color.

## Options considered

### Option 1: One normalized search column per variant, kept by triggers, one trigram index; catalog owned channel upsert matching by ids then SKU (chosen)

Each variant row stores `search_text`, the normalized join of its style's names and code, its SKU code, and its option value labels. Database triggers recompute it when any source changes. One `pg_trgm` GIN index on that column serves "contains every word" queries; the existing `COLLATE "C"` index serves code prefixes and keyset paging; the existing unique index on barcodes serves exact scans. The channel upsert lives in the catalog, takes the ids the connector already mapped, and falls back to the SKU code, the brand's natural key across stores.

**Pros**:
- One query, one index, any word order across style name, code, size, and color, in both languages.
- The database guarantees the column is true on every write path (the spec 0006 create path, the channel sync, the feature 15 import, a hand run migration).
- Matching by SKU joins two stores' copies of the same product and a SKU made by hand before Shopify was connected, without the catalog reading the connector's map.

**Cons**:
- Denormalized: a style rename rewrites its variants' rows (tens of rows, inside one short transaction).
- Triggers are logic outside TypeScript; a developer must know they exist (the db `AGENTS.md` gotcha list and the module README say so).

### Option 2: Fix the existing two branch search in place

Keep the product level expression index and make the query's expression match it, keep the SKU trigram index, and add the Arabic normalization to both expressions.

**Pros**:
- Smallest change; no new column or trigger.

**Cons**:
- Option values live on variants and names on styles, so "black tee" needs both tables; a word on each side cannot be answered by one index, and an `OR` across a join defeats both indexes.
- Results are per style for the name branch, so every match fans out to all of a style's variants, which the page then has to trim.

### Option 3: Trigram plus `simple` full text search, as sketched in spec 0007 section 11

Add a `tsvector` of normalized names with the `simple` configuration beside the trigram indexes, and query words with `to_tsquery` plus trigram for fragments.

**Pros**:
- Word matching with ranking, standard PostgreSQL.

**Cons**:
- The `simple` configuration does no stemming, so for these short product names it adds nothing a "contains every word" trigram query does not already give, and it misses fragments ("blk" in "TEE-BLK-M") that staff type all day.
- Two indexes and two query shapes to keep in agreement at 50,000 rows, where one is ample.

### Option 4: An external search engine

Run a search service beside PostgreSQL and feed it catalog changes.

**Pros**:
- Typo tolerance and relevance ranking out of the box.

**Cons**:
- A new container per client stack, a sync pipeline, and a second source of truth, against spec 0007's one Compose stack per brand and its 50,000 SKU target, which PostgreSQL serves well under budget.

For the channel side the alternative considered was a catalog owned link table (Shopify product and variant ids stored by the catalog). It was rejected because spec 0002 already places `connection_external_ids` in the connectors module, and two owners of one mapping would drift; the catalog needs only to know that a record is linked (`channel_linked_at`) and which name language the channel writes.

## Rationale

The feature's done when is a speed promise on loosely typed Arabic and English, measured at 50,000 variants. Option 1 is the only option that answers a multi word query spanning style and variant fields from one index, and it keeps spec 0007's rule that normalization is one SQL function. Triggers are the right owner for a denormalized column here because at least four writers touch the sources (spec 0006's create path, styles, the channel sync, feature 15's import), and a missed recomputation would make a variant silently unfindable. The cost of the denormalization is bounded: a style has about 10 variants (the scale seed's shape), so a rename touches about 10 rows.

The normalization rules come from the reference brand's own `normalizeName` (`src/lib/cogs/name-match.ts`: alef forms to `ا`, `ى` to `ي`, diacritics and tatweel removed, non letters to spaces) plus three rules its data needs and its code lacks: `ة` to `ه` and hamza on `و` and `ي` (both spellings are common in product names), and Arabic Indic digits to Western (spec 0007 section 10: both digit forms are accepted at every input edge). `unaccent` is left out: brand names here rarely carry Latin accents, and `unaccent` is not immutable, so it cannot sit in an index expression without a wrapper.

The 3 character minimum for the contains branch is a property of trigrams, not a preference: a pattern shorter than 3 characters yields no trigram to look up, so the index would read every entry. Short words still filter the rows a long word found, and a short query still finds codes by prefix and barcodes exactly.

For Shopify, matching by the ids the connector mapped and then by SKU code follows the reference brand, which maps every channel line to a canonical variant by SKU, and spec 0002's choice of SKU code as the per tenant key. One advisory lock per call (on the handle) plus `ON CONFLICT DO NOTHING` on inserts handles two stores' webhooks arriving together; the lead's ruling of 2026-11-11 adds one advisory lock per SKU code the call plans to create (sorted, so two stores carrying one product under different handles still converge on one style), taken only for new codes so a steady state resync takes none. `packages/db/AGENTS.md` warns against per row locks (they exhausted shared memory before): a first import of a 2,048 variant product takes 2,048 advisory locks in one transaction, within the default `max_locks_per_transaction`, and feature 26's deployment notes should size it for several large first imports at once. Field ownership puts content Shopify edits daily (title, price, tags, weight, barcode) with Shopify, and the brand's structure (codes, season, group, Arabic name, cost, archive) with the app, because those drive labels, exports, and margins and must not move when someone edits a product page.

### Decisions settled here (the RECOMMEND items)

- **Search result order**: by SKU code, keyset paged, with the exact barcode and code prefix branches inside the union, not relevance ranking. Why: stable paging with the existing cursor and the existing `COLLATE "C"` index. Runner up: rank exact matches first, which breaks the keyset.
- **Query normalization**: one `SELECT ssd_search_normalize($q)` round trip, then split in the api. Why: the query uses the very function the column uses. Runner up: a TypeScript copy with a parity test, two implementations to keep equal.
- **Option role** (`size`, `color`, `other`) is added now and inferred from the option name. Why: the exchange portal (feature 29) and reports need "same color, another size" and Shopify names options freely in both languages. Runner up: infer at read time each time.
- **Unique option combination among active variants**. Why: two identical active variants of one style cannot be told apart on a pick list or a portal. Partial on `archived_at IS NULL` so a replaced variant can come back as history.
- **Archive rule with several variants**: a style is archived only with its last active variant. Why: the built `setArchived` archives the style with any variant, which was harmless with one variant per style and is wrong now.
- **Seasons and product groups writes need `catalog.manage`; style edits need `catalog.edit`**. Why: seasons and groups are master data like locations (spec 0008 matrix); putting a style into a season is everyday catalog work. No new permission.
- **Backdated cost records need a reason**. Why: a backdated record changes margins already reported (spec 0002 catalog child, the same concern as backdated cost rules, review D5); a reason makes the change explainable in the audit trail.
- **Creates by hand stay unaudited; edits are audited; every channel change is audited**. Why: matches spec 0006 and spec 0010's registry (SKU create is not an audited action), while a system writing on the brand's behalf is exactly what spec 0010 records.
- **No full text search** (Option 3) despite spec 0007's sketch. Why: above; spec 0007's line should be amended by its owner.

## References

**Project sources**
- Scope feature 12, `docs/scope/confirmation-to-cash.md`; planning notes in `docs/scope/index.md` (10,000 SKUs designed, 50,000 tested).
- Spec 0002 `index.md` (A12, AC-30, Follow-up on the trigram index and on `seasons` timestamps, R15) and `0002-catalog-locations.md` (style, season, group, cost lookup, scale table).
- Spec 0006 `index.md` (AC-1 to AC-3, AC-13, the search Value sourcing row).
- Spec 0007 `index.md` sections 10 (digits at input edges) and 11 (search, lists, scale suite).
- Spec 0008 permission matrix and route mapping; spec 0009 settings registry (AC-1, AC-2); spec 0010 registry, record types, and `AuditService.record` (AC-10, AC-11, AC-19).
- Built code: `packages/db/src/schema/catalog.ts`, `apps/api/src/catalog/catalog.service.ts`, `cost.service.ts`, `packages/contracts/src/catalog.ts`, `packages/contracts/src/audit/audit-record-types.ts`, `apps/api/src/module-boundary.spec.ts` (`KNOWN_BREACHES`).
- `packages/db/AGENTS.md` (tenant id in unique keys, custom migrations for triggers, schema qualified functions, no per row advisory locks).
- Reference brand, read only: `src/lib/cogs/name-match.ts` (`normalizeName`), `supabase/migrations/20260916010000_001_foundation.sql` (products by style, variants by SKU), `20260925120000_product_attributes.sql` (style level model and colour); private `docs/positioning/2026-11-05-reference-brand-notes.md` items 2, 4, 10.
- Installed skill `postgresql-table-design` (private `.claude/skills/postgresql-table-design/`): index every foreign key, partial unique indexes, GIN for containment and trigram search.

**Practices & standards**
- `pg_trgm` trigram indexes for substring search; a pattern needs at least one trigram to use the index.
- Denormalized search documents kept by triggers so every writer stays correct.
- Idempotent upserts: compare before writing, natural keys with `ON CONFLICT DO NOTHING`.
- One owner per field in two way integrations.
- WCAG 2.2 AA; right to left layout with logical properties.
