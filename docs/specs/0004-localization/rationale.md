# 0004. Localization: decision record

Build spec: [index.md](index.md).

## Context

> ⚠️ Premise note: this spec assumes staff accounts exist, but sign in (feature 6) has no spec yet. A per user language preference needs an account to belong to. This spec therefore stores the choice per browser (a cookie) and lists moving it to the account as a Follow-up. Separately, this spec replaces two rules of spec 0003 (the development only direction switch and the English only dictionary), so those must be marked superseded when this ships.

The back office must work in English and Arabic from day one (`AGENTS.md`). Feature 4 left only scaffolding: a typed English `t()`, a development only direction switch kept in localStorage, and a root layout that is deliberately static (`cacheComponents` on, no `cookies()` or `headers()`), so `<html lang dir>` cannot be set by the server per request. Radix portals read their own direction provider, never `<html dir>`, so language, `dir`, and Radix must change together.

The scope sets the bar: a user switches language and the whole interface flips direction, no hard coded strings, dates and numbers format per locale, and a third language needs only translations. Other facts shape the choice. The business is Egyptian and works in EGP with Africa/Cairo as the install time zone, staff read figures against scanned labels and accounting exports, one web image serves every client with nothing baked in per client (spec 0001), and client differences must live in settings or `extensions/<client>`. The team is 1 to 3 developers, so the fewest moving parts wins.

If this is not decided, every feature from 7 onward writes its own strings and formats its own figures, and the cost of fixing that grows with each screen.

Engineer decisions that fixed the shape: each user picks the language, remembered in the browser; Western digits in both languages; Gregorian dates with Saturday week start for Arabic; missing bilingual text falls back to the other language, then the code; the api stays free of translations for now; client languages live in `extensions/<client>`; switching is instant with no reload; the choice is stored in a cookie; the first visit uses the install default; codes are isolated left to right; money uses each language's Intl style; day first dates, 24 hour English and 12 hour Arabic clocks; dates show in the install time zone; the enabled languages come from settings; missing text falls back to English with a failing parity test; the switcher sits in the user menu; i18next with its own message syntax; formatting through one browser `Intl` module; lazy catalogs; client files delivered at runtime; raw strings blocked by a lint plugin.

## Options considered

### Option 1: Client side i18next with a language cookie

`i18next` and `react-i18next` hold the text; the active language lives in a cookie read by an inline script before paint; English is bundled, Arabic is a lazy chunk, and client languages are JSON fetched at runtime; one `Intl` module formats everything.

**Pros**:
- Fits the static layout: no server reads of cookies or headers, nothing forces a dynamic render.
- Instant switching, form input survives, and the language never appears in a URL.
- Typed keys through `CustomTypeOptions`, Arabic plurals through `Intl.PluralRules`, a third language is one file.
- Runtime JSON keeps the one web image rule.

**Cons**:
- A returning non English user waits on the catalog behind a hidden body, and the very first visit changes language once.
- Typed plural keys and the wrong key failure mode were not confirmed in research and must be verified at install.
- Client JSON is not type checked.

### Option 2: next-intl with the locale in the URL (`/en`, `/ar`)

The framework native route: locale as a path segment, server rendered pages, ICU messages.

**Pros**:
- First paint is already in the right language and direction; best fit for a public, indexed site.
- Strong Next.js integration and typed messages.

**Cons**:
- Its model reads the locale from the URL or request headers, which conflicts with the static root layout or forces a restructure of every route under a locale segment.
- Language switching means navigation, which can drop unsaved form input.
- Every internal link and the command palette must carry the locale; big churn for a login walled back office with no search engine need.
- Better kept as the choice for the storefront (feature 42), which is public.

### Option 3: react-intl (FormatJS) client side

ICU MessageFormat strings with the same cookie and runtime approach.

**Pros**:
- ICU syntax is what most translation tools expect; small package.
- Ships its own formatting helpers.

**Cons**:
- No built in typed keys, so the current compile time guarantee needs a custom wrapper.
- Plural and select rules live inside strings, which is harder for non developers to edit than plain suffixed keys.

### Option 4: Lingui

Compile time message catalogs with a macro and a very small runtime.

**Pros**:
- Tiny runtime and native ICU.

**Cons**:
- Adds a macro and compile step to the Next.js build, and its v6 typed id support could not be confirmed in research.
- Extraction workflow is heavier than a 1 to 3 developer team needs.

## Rationale

Option 1 fits the actual constraints. The static layout (spec 0003) and the one image rule (spec 0001) both rule out a server that knows the language per request, which is the heart of Options 2's design. The back office sits behind login, so URL locales, server rendered text, and search indexing buy nothing, while losing unsaved form input on a language switch would hurt a long receiving screen. i18next is the one client first library whose typed keys, plural handling through `Intl.PluralRules`, and per language files match what is needed. The research found it compatible with client held locale state and no known Next.js 16 conflict, though the typed key failure mode still needs checking at install.

The cookie beats localStorage because the api can read it later for emails and printed documents, and it matches `ss_location`. The hidden body rule is the price of avoiding a daily flash of English for Arabic users; a 10 second timer owned by the head script keeps it safe. Western digits and the install time zone are chosen for the people who check figures: they match scanned labels and the closed month rules of spec 0002. Money and clock styles follow each language's own Intl pattern, so Arabic readers see native forms without a second code path.

Runtime JSON for client languages is the only route that satisfies both the extensions folder rule and the one web image rule: files bundled into a per client image would break spec 0001, and shipping every language in core would make a client's wording a core release. The cost is losing compile time checking for those files, softened by English fallback and load time validation. The engineer's original pick, `extensions/<client>` files, was kept; only how they reach the browser was settled here.

The literal string lint and the `Intl` restriction are included because the typed `t()` alone catches wrong keys but not raw text, and the scope's "no hard coded strings" cannot hold across 40 features on review alone.

## References

**Project sources**:
- `AGENTS.md` rules: English and Arabic from day one, logical CSS only, config in settings and `extensions/<client>`, one schema per shape, no `NEXT_PUBLIC_*`
- Spec 0001 (one web image for every client, runtime config from `GET /api/config`, extensions folder) · spec 0002 (`settings` table, `{ en, ar }` text) · spec 0003 (static root layout, `DirectionBridge`, the typed `t()` this replaces)
- `apps/web/src/i18n/`, `apps/web/src/shell/direction.tsx`, `apps/api/src/platform/settings.service.ts`, `apps/api/src/platform/config.controller.ts`

**Practices & standards**:
- Externalised strings with a source language fallback; plural categories from CLDR through `Intl.PluralRules`
- Bidirectional text isolation for mixed direction content (the HTML `bdi` element and `dir` attribute)
- Expand and contract migrations (forward only, insert settings with `ON CONFLICT DO NOTHING`)

**Links** (web verified in this design session, versions as of the check and to be re-confirmed at install):
- next-intl latest release: https://registry.npmjs.org/next-intl/latest
- react-i18next latest release: https://registry.npmjs.org/react-i18next/latest
- react-intl latest release: https://registry.npmjs.org/react-intl/latest
- Lingui React latest release: https://registry.npmjs.org/@lingui/react/latest
- next-intl routing setup (locale from URL or headers, static rendering notes): https://next-intl.dev/docs/routing/setup
- react-i18next TypeScript overview: https://react.i18next.com/latest/typescript
- Next.js caching and cache components: https://nextjs.org/docs/app/getting-started/caching
- Not verified: Lingui v6 typed ids and setup (the guide returned 404), react-intl typed keys, and how react-i18next fails wrong keys and types plural keys.

## Amendment 2026-11-05: rationale

Scope feature 6 is amended in place (Shape A of spec 0007). Context, options, and rationale above stay as the record of the original decision. This section records only what the delta decided. Build spec: [index.md](index.md), section `Amendment 2026-11-05`.

### Context added

- Text is needed outside the browser. `apps/api/src/mail/mail-templates.ts` has its own `COPY` table of English and Arabic text, and the daily report, WhatsApp messages, export labels, and receipts are coming in the worker (spec 0007, section 10). Two sources of Arabic text would drift.
- The portal and partner pages are opened by customers on slow phones from links the system sends. The head script and hidden body rule was designed for staff.
- Egypt observes daylight saving (the tz data in Node 2026a shows 24 Apr 2026 with 23 hours and 29 Oct 2026 with 25 hours), so a day key must come from one SQL function and be tested on the real dates (Carried row m7).

### Options considered (the delta)

**Where the shared catalog lives.**

- Option A, chosen: a new `packages/i18n`. It matches the module map in spec 0007, keeps React out of the api and worker, and lets Arabic stay a lazy subpath for the web. Cost: one more package to build before the web.
- Option B: keep the catalogs in `apps/web` and import them from the api. Not chosen: the api and worker would depend on a Next.js app folder.
- Option C: put the catalogs in `packages/contracts`. Not chosen: contracts holds request and response shapes, and text changes for a different reason.

**How portal and partner pages know the language on the server.**

- Option A, chosen: the language in the URL (`/ar/returns`), read as a root parameter, one root layout per audience. The page prerenders per language under Cache Components, works with scripts blocked, and a link sent on WhatsApp carries its language. The cost is a structural change (multiple root layouts, an experimental global 404, moved pages) and a full page load between audiences, which the Next.js docs state.
- Option B: read the `ss_lang` cookie with `cookies()` in the root layout. Not chosen: the installed docs say `cookies()` outside a Suspense boundary stops the route from prerendering under Cache Components, and `<html>` cannot sit inside Suspense, so the whole app, back office included, would turn dynamic.
- Option C: keep the static root layout and put `lang` and `dir` on a wrapper element. Kept only as the named fallback: `<html lang>` would stay wrong for screen readers, and Radix portals mount on the body, outside the wrapper.
- Option D: a language subdomain. Not chosen: one host per install (spec 0007, hosting), and Caddy and certificates would grow for no gain.

**Does the back office change.** Decided no (AC-17). It sits behind a login, may use a client language that exists only as runtime JSON (the server cannot read it yet), and the original verify run passed all 13 criteria. The trigger to revisit is a measured wait, recorded as a Follow-up, not a feeling.

**Digit input.** Decided: normalize at the edge by schema, with a strict comma rule (no guessing `1,5`), and display stays Western. Showing Arabic digits would undo the original reason: figures must match scanned labels, exports, and the closed month rules. Silently rounding extra fraction digits was rejected, because a money field that changes what was typed hides mistakes.

**Where the formatters live.** Moved into the package so the worker's report and the web screen cannot disagree; the lint ban follows the module. The original rule (one module, fixed `Intl` options) is unchanged.

**Operating day.** The function is owned by feature 4 (data model); this spec owns the display and the test. The test computes the release year from the rule and checks PostgreSQL against Node `Intl`, so a change in Egypt's rules fails a build and not a report. Pinning only 2026 would rot; computing only from the rule would hide a tz data error; the test does both.

### References added

**Project sources**: spec 0007 sections 2, 3 and 10 and the Carried row m7 ([spec 0007](../0007-stack-architecture-operations-layer/index.md)); positioning sections 6.4, 6.11, 6.15 (positioning (kept private)); `docs/scope/foundations.md` feature 6; `apps/web/src/app/layout.tsx`; `apps/web/src/proxy.ts`; `apps/api/src/mail/mail-templates.ts`; `packages/db/migrations/0001_core_data_model.sql` (seeds `currency` and `timezone`).

**Installed Next.js 16.4.3 docs** (read in this session, under `apps/web/node_modules/next/dist/docs/01-app/`): `03-api-reference/03-file-conventions/route-groups.md` (multiple root layouts, full page load), `03-api-reference/03-file-conventions/layout.md` (root layout rules), `03-api-reference/03-file-conventions/not-found.md` (`global-not-found`, experimental), `03-api-reference/04-functions/next-root-params.md` (root parameters and the `generateStaticParams` requirement), `03-api-reference/04-functions/cookies.md` (Suspense under Cache Components), `02-guides/internationalization.md`.

**Run in this session**: `node -e` with `Intl.DateTimeFormat` and `timeZone: 'Africa/Cairo'` on the instants in the spec (Node tz data 2026a).

**Not verified**: the Egyptian rule text from the IANA source (the rule used, last Friday of April to last Thursday of October, matches the Node output for 2026 and 2027 but was not read from the tz database); that `experimental.globalNotFound` keeps the production `/design` 404 working; that WhatsApp template bodies can be held as per language fixtures (Meta documentation not checked); that `process.versions.tz` is available on the Node 26 image (it printed `2026a` on the Node used here).
