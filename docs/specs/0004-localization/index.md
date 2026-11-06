# 0004. Localize the back office with client side i18next, a language cookie, and one shared formatting module

**Date**: 2026-11-03
**Status**: Proposed (amendment of 2026-11-05 for scope feature 6; the original decision was accepted and built)

## Summary

This spec makes every screen work in English and Arabic and lets a user switch between them without reloading. The choice is saved in a browser cookie, so the page opens in the right language and direction before it paints. Numbers always use Western digits (0 to 9), dates read day, month, year in the install's own time zone, and money follows the install's currency. A client can add a third language by dropping one JSON translation file into `extensions/<client>/locales` and enabling it in settings, with no code change and no new web image. It replaces the development only direction switch from the design system spec.

## Amendment 2026-11-05

Scope feature 6 shrinks to this delta (Shape A of [spec 0007](../0007-stack-architecture-operations-layer/index.md), section 10 and the Carried row m7). Everything above and below stays true unless a paragraph carries the line `Amended 2026-11-05`. Mode: ENHANCEMENT. References level: `sources`.

### Why

The product is now an order operations layer for Egyptian brands. Three things changed for localization:

1. Text is no longer only a web concern. The api sends mail, and the worker writes the daily report, WhatsApp messages, export column labels, and receipts. Today the catalogs live inside `apps/web/src/i18n/locales/`, and `apps/api/src/mail/mail-templates.ts` keeps its own hand written English and Arabic table. Two sources of Arabic text will drift.
2. Customers and partners use public pages on slow phones. Spec 0004 renders English first and hides the body until Arabic arrives (AC-3). That is fine behind a staff login, but a customer opening a returns link should see Arabic at first paint.
3. Egyptian staff and customers type Arabic digits and Arabic separators (phone numbers, quantities, amounts), and every figure is keyed on the Cairo operating day, which has a 23 hour day and a 25 hour day each year because Egypt observes daylight saving.

### New requirements (continue the numbering)

- **AC-14 (replaces the file layout of the original Feature design)**: A new workspace package `packages/i18n` (`@ssdashboard/i18n`) owns the message catalogs, the typed key list, the language registry (the original `languages.ts`), the right to left base code list and `directionOf` (the original `language-config.ts` parts that are not about the cookie or the head script), and the pure formatting functions. English is `en` and the type source; `ar` is a separate subpath export (`@ssdashboard/i18n/ar`) so the web bundler keeps it a lazy chunk. `apps/web`, `apps/api`, and the worker import from it. `apps/web/src/i18n/locales/` is deleted (moved, not copied); the web keeps only what is about the browser: `language-provider.tsx`, the cookie and head script (`language-config.ts` cookie parts), `runtime-languages.ts`, `use-format.ts`, and `localized-text.ts`. The package has no React and no `react-i18next`; it depends on `i18next` only. It has a `README.md` in the module template and TSDoc on every export.
- **AC-15 (extends AC-5, AC-6, AC-7)**: One non React translator, `createTranslator(language)`, returns (a promise of) `{ t, language, dir }` for any code. It is built on an `i18next` instance with English as the fallback, so an unknown language, or a key missing from Arabic, gives English and never a raw key. `t` is typed by `MessageKey`, so a wrong key fails `tsc` in the api and worker as it does in the web. Catalog keys are grouped by who needs them: shell and screens (existing), `mail`, `report`, `export`, and `receipt`. The parity test (every English key exists in Arabic, plural forms compared per language) moves to `packages/i18n` and covers all groups; the web test that imports the catalog stays as a thin check that the web uses the package. `apps/api/src/mail/mail-templates.ts` drops its private `COPY` table and renders from the `mail` keys through `createTranslator`; its output for the two existing messages (`reset`, `invite`) in English and Arabic does not change (a snapshot test pins it). The worker's daily report and export labels use the same translator the day they are written; this spec fixes the contract, the features that write them add the keys. WhatsApp templates are Meta approved texts with positional parameters, so the catalog holds the template name and the parameter order, and the approved body per language is a fixture that must exist for both languages (the same parity rule); the WhatsApp feature owns the content.
- **AC-16 (replaces AC-3 for the portal and partner audiences)**: Pages in `(portal)` and `(partner)` live under a `[lang]` segment (`/ar/returns`, `/en/returns`), where `lang` is `en` or `ar`. Each of the two audiences has its own root layout at `(portal)/[lang]/layout.tsx` and `(partner)/[lang]/layout.tsx` that renders `<html lang dir>` on the server from the `lang` root parameter (`next/root-params`) and renders the page text on the server from `@ssdashboard/i18n`. These two root layouts carry no language head script and never hide the body. A request without a language prefix is redirected (307) in `proxy.ts` to the same path with a prefix, chosen by cookie `ss_lang` if it is `en` or `ar`, else the first of `en` or `ar` in the `Accept-Language` header, else `ar` (see Questions for the owner). A path with a valid prefix refreshes cookie `ss_lang` (same attributes as AC-1). _Amended 2026-11-06 (AC-23 wins over this sentence): a cookie that is a valid language code (`^[a-z]{2,3}$`) but not a core language, such as a client's `fr`, redirects to `en`; `Accept-Language` is consulted only when the cookie is absent or invalid, then `ar`. A prefixed path refreshes `ss_lang` only when the cookie is absent or already `en` or `ar`, so a staff member's client language is never overwritten by opening a portal or partner link._ Each page has a plain link to the same page in the other language (works with scripts blocked). The provider for these pages starts in the page's language with its catalog passed from the server, so there is no effect swap and no hydration warning. `generateStaticParams` lists `en` and `ar`, so both prerender; any other `lang` is a real 404. Only the core languages (`en`, `ar`) are available on these two audiences in this release.
- **AC-17 (decision, keeps AC-1 to AC-4, AC-13 for `(backoffice)` and `(auth)`)**: The staff back office and the sign in pages keep the cookie, the head script, the hidden body rule, and the English first render exactly as built. Staff are behind a login, already on a warm session, and may use a client language that only exists as a runtime JSON file; changing this would put `cookies()` into a shell that is otherwise static and gain only a few hundred milliseconds. Revisit only if a measurement on Slow 4G shows a returning Arabic manager waits more than 2 seconds behind the hidden body (Follow-up). To make AC-16 possible, `(backoffice)` and `(auth)` each get their own root layout built from one shared static root frame component (the current `app/layout.tsx`, moved), so their behaviour does not change.
- **AC-18 (new)**: Arabic and Western digits are both accepted at every input edge and normalized there. `@ssdashboard/i18n` exports `normalizeDigits(text)` (maps Arabic-Indic U+0660 to U+0669 and Extended Arabic-Indic U+06F0 to U+06F9 to 0 to 9, the Arabic decimal separator U+066B to `.`, the Arabic thousands separator U+066C and the Arabic comma U+060C to `,`, and removes the invisible marks U+200E, U+200F, U+061C and the no break space), `parseQuantity(text)` (digits only after normalizing; `"٣"` gives `3`), and `parseMoney(text, digits)` (a decimal string with at most `digits` fraction digits, `2` for amounts and `4` for unit costs). A comma is accepted only as a thousands separator in a valid grouping (`1,234.50`); `1,5` is rejected with a field error and never guessed; more fraction digits than allowed is rejected, never rounded. `packages/contracts` gains Zod helpers built on these (`westernDigits`, `quantityInput`, `moneyInput`) that every numeric and phone field in a request schema uses, so the api normalizes at the edge with the same rule the web form uses through its Zod resolver. Phone normalization to one canonical form (010, 0010, +2010) belongs to the customers feature (11), which must call `normalizeDigits` first. These helpers are never applied to passwords, tokens, free text, names, or search boxes (a password typed with Arabic digits stays as typed). Display rules from AC-8 are unchanged: Western digits are always shown.
- **AC-19 (replaces the location of AC-8, keeps its rules)**: The formatting functions of AC-8 (`number`, `quantity`, `percent`, `money`, `date`, `dateNumeric`, `dateOnly`, `time`, `dateTime`) move to `@ssdashboard/i18n` as `createFormatter({ language, currency, timezone })`, which returns the same nine functions with the same fixed `Intl` options, so the worker, the api, and the web produce identical text. The web `use-format.ts` stays and wraps it with the settings from `GET /api/config`. The lint ban on `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, and `new Intl.*` now exempts `packages/i18n/src/` instead of `apps/web/src/i18n/format.ts`, and applies to `apps/api` and the worker too (built 2026-11-05 stricter: only the two package files that build `Intl`, `format.ts` and `plural-categories.ts`, are exempt). Money is EGP: the `currency` setting is seeded `"EGP"` (migration 0001, already so) and every formatter call takes it from the setting, never a literal; a test asserts `createFormatter({ currency: 'EGP', language: 'ar' })` and the English form for `"1234.5"` with `digits` 2.
- **AC-20 (extends AC-8)**: Dates and times show in the install time zone (default `Africa/Cairo`) for every user and every process. The operating day is never computed in TypeScript: the web, api, and worker get the day from SQL (`ssd_operating_day(timestamptz)`, owned by the data model feature 4) and only display it. An operating day arrives as a `YYYY-MM-DD` value and is shown with `dateOnly`, so it never shifts. Display tests use the Cairo daylight saving transition instants of 2026 (see Feature design, Operating day display): the formatter shows `2026-04-23T22:00:00Z` as `01:00` on 24 Apr 2026 (the clock jumped over midnight, so `00:00` never appears that day), and `2026-10-29T20:30:00Z` and `2026-10-29T21:30:00Z` both as `23:30` on 29 Oct 2026 (the repeated hour).
- **AC-21 (new, the test the Carried row m7 requires)**: A database backed test in `packages/db` (run by `pnpm --filter @ssdashboard/db test:e2e`) asserts `ssd_operating_day()` on the real Cairo daylight saving transition instants of the release year. It uses a fixed table for 2026 and computes the release year's two dates from the rule (the last Friday of April starts summer time at 00:00, the last Thursday of October ends it at 24:00), then checks the answer from PostgreSQL against `Intl` in Node for every row. It fails if the count of offset changes in the release year is not exactly two, so a rule change by the Egyptian government fails the build instead of shifting reports. The feature that owns the column and function is the data model feature 4; this spec owns the display rule and this test, which can only run once that function exists.
- **AC-22 (new, release step)**: Refreshing time zone data is a named release step (the runbook is feature 26). This spec provides the check: `pnpm check:timezone` (a root script added with this work) prints `process.versions.tz` and `process.versions.icu` for the Node version of the `app` and `web` images (read from the same `NODE_VERSION` build argument both Dockerfiles use) and the PostgreSQL server version, then runs the AC-21 test. A release is not tagged if the check fails. The operator also rebuilds both images from a current Node base image and pulls a current PostgreSQL 18 patch release, because the three carry separate copies of the time zone data.
- **AC-23 (carries AC-11 forward)**: Extension locales are unchanged: `extensions/<client>/locales/<code>.json`, the `_meta` block, runtime fetch from `/locales/<code>.json`, English fallback, hidden when malformed. They apply to the back office only. Portal and partner pages (AC-16), mail, the report, and exports support the core languages; a user whose saved language is a client language receives English in those places until a server side loader exists (Follow-up). The new key groups (`mail`, `report`, `export`, `receipt`) appear in the file format as nested keys like any other.

### Design delta

**What this adds:** `packages/i18n` (AC-14 and AC-15, AC-18, AC-19), `[lang]` root layouts for two audiences (AC-16), the digit rules (AC-18), the operating day display and test (AC-20, AC-21), and the release step (AC-22).

**What it replaces in the original text:** the file layout under `apps/web/src/i18n/` (locales and formatting module), the server first render claim for the whole app, and the single module claim of AC-8. Each is marked inline below.

**Package shape (Assumed: mirrors `packages/contracts`, which builds to `dist` with `tsc -p tsconfig.build.json`):**

| Export | Path | Contents |
|---|---|---|
| `.` | `@ssdashboard/i18n` | `en`, `Catalog`, `MessageKey`, `CORE_LANGUAGES` (registry), `directionOf`, `RTL_LANGUAGES`, `createTranslator`, `createFormatter`, `normalizeDigits`, `parseQuantity`, `parseMoney` |
| `./ar` | `@ssdashboard/i18n/ar` | `ar` (the Arabic catalog) |

`createTranslator` loads `ar` by dynamic `import()`, so it is `async` the first time per language and cached; `createTranslatorSync(language, catalogs)` is what a server component and the web provider use when the catalog is already in hand (built 2026-11-05 with the `language` argument, which this line first left out). Web code keeps `react-i18next` for components. `packages/contracts` depends on `@ssdashboard/i18n` for the digit helpers only.

**Server rendered audiences (AC-16), route layout:**

```
apps/web/src/app/
  (backoffice)/layout.tsx        root layout, static, StaticRootFrame (head script)
  (auth)/layout.tsx              root layout, static, StaticRootFrame (head script)
  (portal)/[lang]/layout.tsx     root layout, <html lang dir> from next/root-params
  (portal)/[lang]/returns/...    pages (moved under [lang])
  (partner)/[lang]/layout.tsx    root layout, same
  (partner)/[lang]/partner/...   pages (moved under [lang])
```

The four route groups stay exactly the four audiences (`check-route-groups.mjs` still passes; `[lang]` is a segment, not a group). There is no `app/layout.tsx` any more, because a layout above them would stop them being root layouts. The Next.js docs say the route-group root layout feature exists for this ("Defining multiple root layouts") and that moving between root layouts is a full page load (`apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-groups.md`), which is acceptable between audiences. A root layout under a dynamic segment is supported and the segment is read with `next/root-params`, and with Cache Components each root parameter needs at least one `generateStaticParams` value (`.../04-functions/next-root-params.md`). The docs also say that an app with multiple root layouts needs `global-not-found.js` (experimental, enabled by `experimental.globalNotFound`) to define a 404 for unmatched routes (`.../03-file-conventions/not-found.md`). That is a risk this spec names: the first task of milestone 3 is to prove that the production `/design` 404 (rewritten by `proxy.ts` to `/_not-found`) still answers a real 404, with the fallback below if it does not.

**Fallback if the multiple root layouts or the experimental 404 prove unusable (decided now so a builder does not improvise):** keep one static `app/layout.tsx`; portal and partner pages still sit under `[lang]` (the URL carries the language), render all text on the server, and wrap their frame in `<div lang dir>`; the head script is not injected for these two audiences by making the script conditional on the pathname in the static layout (it reads `location.pathname`, and does nothing on a path that starts with `/en/` or `/ar/` of these audiences). Costs: `<html lang dir>` stays English left to right on these pages, which is weaker for screen readers. Only use it if the preferred route fails the first task, and record it in the spec.

**Operating day display (AC-20, AC-21):** the DST facts, from the tz data in Node `2026a` (`node -e` on `Intl.DateTimeFormat` with `timeZone: 'Africa/Cairo'`, run 2026-11-05):

| Instant (UTC) | Cairo wall clock | Meaning |
|---|---|---|
| `2026-04-23T21:59:59Z` | 23 Apr 23:59:59 (UTC+2) | last second of winter time |
| `2026-04-23T22:00:00Z` | 24 Apr 01:00:00 (UTC+3) | summer time starts; 24 Apr has 23 hours, local 00:00 does not exist |
| `2026-10-29T20:59:59Z` | 29 Oct 23:59:59 (UTC+3) | first pass of the last hour |
| `2026-10-29T21:00:00Z` | 29 Oct 23:00:00 (UTC+2) | summer time ends; 29 Oct has 25 hours |
| `2027-04-29T22:00:00Z` | 30 Apr 01:00:00 (UTC+3) | 2027 start (rule: last Friday of April) |
| `2027-10-28T21:00:00Z` | 28 Oct 23:00:00 (UTC+2) | 2027 end (rule: last Thursday of October) |

Expected `ssd_operating_day()` for the 2026 rows (the AC-21 table): `2026-04-23T21:59:59Z` gives `2026-04-23`; `2026-04-23T22:00:00Z` gives `2026-04-24`; `2026-04-24T20:59:59Z` gives `2026-04-24`; `2026-04-24T21:00:00Z` gives `2026-04-25`; `2026-10-28T21:00:00Z` gives `2026-10-29`; `2026-10-29T21:59:59Z` gives `2026-10-29`; `2026-10-29T22:00:00Z` gives `2026-10-30`. A day's hour count (23 on 24 Apr, 25 on 29 Oct) is asserted by counting hourly instants per operating day across the transition. The 2027 dates are computed from the rule and checked against tz data in the test; they are not hand pinned.

**Value sourcing (additions to the original table):**

| Action | Value produced / displayed | Source |
|---|---|---|
| Portal or partner page | `lang`, `dir`, text | `lang` root parameter (URL), `directionOf(lang)`, `@ssdashboard/i18n` catalogs on the server |
| Unprefixed portal link | which language to redirect to | cookie `ss_lang` (`en` or `ar`); a valid non-core code gives `en` (amended 2026-11-06, AC-23); else `Accept-Language`, else `ar` |
| Mail, report, export, receipt text | translated text | `createTranslator(language)` from `@ssdashboard/i18n`; language from the person's saved language, else setting `default_language` |
| Any amount outside the web | currency | setting `currency` (seeded `"EGP"`) |
| Operating day shown anywhere | the date | `ssd_operating_day(timestamptz)` in SQL, shown with `dateOnly` |
| Typed number, quantity, amount, phone | normalized value | `normalizeDigits` then `parseQuantity` or `parseMoney`, applied by the Zod helper in `packages/contracts` |

**Security and privacy:** the translator and formatter take no personal data; report text that includes a customer name is built by the caller and passes through `RedactingLogger` rules like any other value (Law 151). `lang` from the URL is matched against `en` and `ar` before use (no reflection). `normalizeDigits` is pure and cannot loop.

**Critical test scenarios (continue the original list):**
- Package: parity across all key groups; an unknown language and a key missing from `ar` give English; a wrong key fails `tsc` in a fixture file in `apps/api`, verifies **AC-14**, **AC-15**.
- Mail snapshot: `reset` and `invite` in English and Arabic render the same text before and after the move, verifies **AC-15**.
- Portal: `GET /ar/returns` returns HTML whose `<html>` has `lang="ar" dir="rtl"` and Arabic text with scripts disabled, and no `data-i18n="pending"`; `GET /returns` with `Accept-Language: ar-EG,ar;q=0.9` redirects to `/ar/returns`; `/fr/returns` is 404; the language link goes to `/en/returns` and sets the cookie, verifies **AC-16**.
- Back office unchanged: the original e2e tests for AC-1 to AC-4 and AC-13 still pass on `(backoffice)` and `(auth)`, verifies **AC-17**.
- Digits: `"٣"`, `"۳"`, `"٣٫٥"`, `"1٬234٫50"`, `"١٢٣٤.٥٠"` parse; `"1,5"`, `"1.234"` with `digits` 2, and `"12a"` are rejected with a named error; a request body with an Arabic digit quantity is accepted by the api and stored as the Western integer; a password field is untouched, verifies **AC-18**.
- Formatting parity: web `useFormat` and worker `createFormatter` give identical text for the nine functions, for `EGP`, `ar` and `en`, verifies **AC-19**.
- Display on transition instants (table above), verifies **AC-20**.
- Operating day on real transition dates against PostgreSQL and Node `Intl`; the offset change count of the release year is two, verifies **AC-21**.
- `pnpm check:timezone` prints the versions and exits non zero when the AC-21 test fails, verifies **AC-22**.
- Extension: the original `fr.json` test still passes, and the same user on a portal page sees English with a French cookie, verifies **AC-23**.

## Questions for the owner

1. **Language for an unprefixed portal or partner link with no cookie and no `Accept-Language`.** Recommended default: Arabic (`ar`), because the customers are Egyptian and the positioning says Arabic first. Alternative: the install's `default_language` setting, which needs the proxy to ask the api for `GET /api/config` (an extra call per first visit, cached). Until answered, build the Arabic default.
2. **Who reads the new Arabic text.** The report, mail, export labels, and receipts add many Arabic strings. Recommended default: the same Arabic speaker review that is still open from the original build (verify.md) covers the new key groups before a client goes live in Arabic. No code change either way.

## Requirements

**User stories**:
- As a staff member, I want to switch the interface between English and Arabic from the user menu, so I can work in the language I read fastest.
- As an Arabic speaking staff member, I want the whole screen to flip right to left, including menus and popups, so nothing looks half translated.
- As a returning user, I want the page to open in my last language without a flash of the other one.
- As an accountant, I want amounts, quantities, and dates to look the same in both languages (Western digits, day first dates, the install's time zone), so figures match exports and scanned labels.
- As a client administrator, I want to add a language by supplying a translation file and enabling it in settings, so a new market needs no developer.
- As a developer, I want a wrong text key, a missing Arabic string, or a raw string in markup to fail the build, so translation debt cannot build up.

**Acceptance criteria**:
- **AC-1**: The user menu has a Language submenu listing every enabled language by its own name ("English", "العربية"), each option carrying its own `lang` and `dir`. Choosing one changes all shell text, `<html lang>`, `<html dir>`, and the direction Radix gives to every portal (dropdown, popover, tooltip, sheet), with no page reload. Text typed into a form on the page is not lost. The choice is stored in cookie `ss_lang` and survives a reload.
- **AC-2**: Direction follows the language: Arabic is right to left, English is left to right. The development only Direction submenu, the `ss_dir` localStorage key, and the development only direction script are gone. A production build honours the cookie (spec 0003 AC-11 no longer holds in that part).
- **AC-3**: With no cookie, the first visit shows the install default language from `GET /api/config`, then writes `ss_lang` so later visits need no wait (one brief language change on that first visit only is accepted). With a cookie, the inline script in `<head>` sets `lang` and `dir` before first paint, and for a language other than English it keeps the page body hidden until its catalog is applied (a 10 second cap, run by the script itself, so a failed load never leaves a blank page). A returning Arabic user never sees English text flash.

> Amended 2026-11-05: for the `(portal)` and `(partner)` audiences, replaced by Amendment AC-16 (language in the URL, server rendered, no head script). This paragraph still holds for `(backoffice)` and `(auth)` (AC-17).

The server snapshot and the first client render are always English left to right (matching the prerendered HTML); the cookie language is applied in an effect after hydration, behind the hidden body, so there is no hydration mismatch (a test checks that an Arabic load logs no hydration warning).
- **AC-4**: Settings rows `languages` (default `["en","ar"]`) and `default_language` (default `"en"`) exist after migration, and `GET /api/config` returns `languages`, `defaultLanguage`, `currency`, and `timezone` besides `clientName` and `version`. If the saved language is not enabled, the install default is used and the cookie is rewritten. If the config call fails, the saved language is kept when its catalog loads, else English left to right; the shell still works, and the next config read retries instead of caching the failure. If `default_language` is an enabled language whose catalog is missing or invalid, the first enabled language with a loadable catalog is used, else English, and the cookie is not written until a language actually applies. The new `ConfigResponse` fields have zod defaults (`languages` `['en']`, `defaultLanguage` `'en'`) and `currency` and `timezone` are optional, so an older api never breaks a newer web, and the two images may differ in version. If the api cannot read settings it still answers with `clientName`, `version`, and those defaults, and logs the error.
- **AC-5**: No UI string is hard coded. All text in `apps/web` comes through typed keys (a wrong key fails the type check), `packages/ui` takes text only through props, and `lint` fails on a raw literal in markup (JSX text and the `aria-label`, `title`, `placeholder`, and `alt` attributes), with development only `/design` specimens, test specs (`*.spec.ts` and `*.spec.tsx`), and e2e files exempt.
- **AC-6**: A test fails the build when the Arabic catalog lacks any English key (plural keys compared by the plural forms each language needs). At runtime a missing translation falls back to English; a raw key is never shown.
- **AC-7**: Interpolation (`{{name}}`) and plurals work in both languages. Arabic selects the right one of its six forms for counts 0, 1, 2, 3, 11, and 100 (checked with `Intl.PluralRules`, not hand written rules).
- **AC-8**: 

> Amended 2026-11-05: the module location and the lint ban exemption are replaced by Amendment AC-19 (`packages/i18n`, shared with the api and worker). The formatting rules below still hold.

One module, `apps/web/src/i18n/format.ts`, formats numbers, integer quantities, percents, money, dates, times, and date and time values, each a named function with fixed `Intl` options (listed under Feature design, Formatting options). Digits are always Western. Decimal strings from the api are passed to `Intl` as strings, so a 4 decimal cost never loses precision. Money uses the `currency` setting with that language's Intl style (English `EGP 1,234.50`, Arabic with its own symbol). Instants display in the `timezone` setting for every user, day first; English uses a 24 hour clock, Arabic a 12 hour clock with ص/م. A date only value (`YYYY-MM-DD`) never shifts a day. `lint` fails on `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, or `new Intl.*` outside this module, test specs, and e2e files. An invalid `currency` or `timezone` setting is rejected when settings are read, and any remaining `Intl` error makes the formatting status `'error'` instead of crashing a screen.
- **AC-9**: Bilingual stored text (`{ en, ar }`, spec 0002) shows the active language, else the install default language, else any other non empty language in enabled order, else the code. Values are trimmed first. `locationName()` in `apps/web/src/shell/current-location-provider.tsx` takes the active and default language and uses this rule instead of its current English first rule.
- **AC-10**: A shared `LtrText` component isolates codes (SKU, barcode, document number, email, URL) as left to right inside right to left text. `packages/ui/DESIGN.md` says to use it for every such value.
- **AC-11**: A client language is added by a file `extensions/<client>/locales/<code>.json` (with a `_meta` block holding the language's own name and its Intl tag) plus the code in the `languages` setting. The file is served by Caddy at `/locales/<code>.json` and fetched at runtime, with no change to the web image. Keys it lacks fall back to English. A file that is missing, malformed, or has no `_meta` hides that language from the switcher and logs a console warning; it never breaks the shell. A client language appears in the menu only after its file has loaded and validated, and the menu always keeps the `languages` order.
- **AC-12**: axe reports zero violations on the shell in Arabic and English. At 375px wide in Arabic nothing in the shell is clipped or overlapping, and Arabic text renders in IBM Plex Sans Arabic (spec 0003 AC-13 still holds).

> Amended 2026-11-06 (Daftar built): Arabic text now renders in Noto Sans Arabic, not IBM Plex Sans Arabic (spec 0003 AC-13 as amended).
- **AC-13**: If a language's catalog fails to load when chosen, the current language stays, the cookie is unchanged, and the Language submenu shows an inline error line, which clears on the next menu open or next choice. If two choices overlap (B chosen while A is still loading), the last choice wins and the stale load is dropped.

## Decision

**Chosen option**: Option 1: client side i18next with a language cookie, bundled English, lazy core languages, and runtime client languages

Use `i18next` with `react-i18next` for text and plurals, keep the active language in a `ss_lang` cookie read by an inline script before paint, route all number, money, and date output through one `Intl` based module, and deliver extra client languages as JSON files served at runtime so the one shared web image never changes.

**Implementation skills**: `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `vercel-react-best-practices` (`.claude/skills/vercel-react-best-practices/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`) · `pnpm` (`antfu/skills`, `.claude/skills/pnpm/`)

## Feature design

**Data model sketch**: no new tables. Two new rows in the existing `settings` table (spec 0002), added by a forward only migration that uses `ON CONFLICT DO NOTHING`:

| Key | Stored shape | Seeded value |
|---|---|---|
| `languages` | `jsonb` array of 2 to 3 letter lowercase codes, at least one, in switcher order | `["en","ar"]` |
| `default_language` | `jsonb` string, one of `languages` | `"en"` |

`SettingShapes` in `settings.service.ts` gains both with a `^[a-z]{2,3}$` check (`languages` also rejects duplicates and requires `default_language` to be listed), and `currency` is tightened to `^[A-Z]{3}$` and `timezone` to a name that `new Intl.DateTimeFormat('en', { timeZone })` accepts. Browser state only otherwise:

| Store | Key | Value | Owner |
|---|---|---|---|
| Cookie (read by the head script and by the client) | `ss_lang` | a language code; `Path=/`, `Max-Age=31536000`, `SameSite=Lax`, `Secure` when `location.protocol === 'https:'`, not `HttpOnly` | `LanguageProvider` |
| localStorage | `ss_dir` | removed | direction switch (gone) |

**State transitions**: a language moves `unloaded` → `loading` → `active`. Failure goes `loading` → `unloaded` and the previous language stays active (AC-13). The page body is `hidden` only between the head script and the first `active` (AC-3).

**Files and structure** (folder by feature under `apps/web/src/i18n/`):
> Amended 2026-11-05: the catalogs, the registry, and the formatting module in this list move to `packages/i18n` (Amendment AC-14, AC-19). Only the browser parts (provider, cookie, head script, runtime languages, hooks) stay under `apps/web/src/i18n/`.

- `locales/en.ts`: the English catalog (the current `messages.en.ts`, an `as const` object). It is the source language: bundled in the main chunk, the type source, and the fallback.
- `locales/ar.ts`: the Arabic catalog, a lazy chunk (`import('./locales/ar')`).
- `languages.ts`: the core registry `{ en: { nativeName: 'English', intl: 'en-GB', hour12: false, weekStart: 1 }, ar: { nativeName: 'العربية', intl: 'ar-EG', hour12: true, weekStart: 6 } }`. Every formatter adds `numberingSystem: 'latn'`.
- `language-config.ts`: a plain module (no `'use client'`, same reason as `direction-config.ts`): cookie name and options, the right to left base codes (`ar`, `he`, `fa`, `ur`, `ps`, `sd`, `ug`, `yi`, `dv`, `ckb`), and the head script text.
- `language-provider.tsx`: client provider that owns the state above, initialises i18next, loads catalogs, sets `<html lang dir>`, wraps Radix `Direction.Provider`, and writes the cookie. It replaces `DirectionBridge` and `direction-config.ts`.
- `format.ts` and `use-format.ts`: the formatting module and its hook. `localized-text.ts`: the AC-9 rule.
- `runtime-languages.ts`: fetches and validates `/locales/<code>.json` for enabled languages that are not core.
- Typing: `declare module 'i18next'` with `CustomTypeOptions { defaultNS: 'translation'; resources: { translation: typeof en } }`. `MessageKey` stays exported for `nav.ts`. Components use `useTranslation()`; the old `t.ts` goes. The server root layout keeps no text: the skip link becomes a small client component `SkipLink`.

**Runtime behaviours**:
- i18next options: `fallbackLng: 'en'`, `interpolation.escapeValue: false` (React escapes output; translations are never rendered with `dangerouslySetInnerHTML`, and `Trans` is used only with an explicit component list), `returnNull: false`. English plurals use `_one` and `_other`; Arabic uses all six suffixes.
- Head script (always in the layout, production included): read `ss_lang`, accept only `^[a-z]{2,3}$`, set `document.documentElement.lang` and `dir` (right to left when the base code is in the list), and when the code is not `en` set `data-i18n="pending"` and arm a 10 second timer that removes it. `globals.css` has `html[data-i18n="pending"] body { visibility: hidden }`. The provider removes the attribute once the catalog is applied.
- Choosing a language: load the catalog first (core: dynamic import; client: fetch), and only on success change i18next, `<html lang dir>`, the Radix direction, and the cookie; the old text stays until then.
- After config loads: effective language = cookie value if it is in `languages` and its catalog is available, else `default_language` (written to the cookie). Non core enabled languages are fetched in the background; one is listed in the menu once its file has loaded and validated.
- Runtime JSON shape: flat or nested keys matching `en.ts`, plus `"_meta": { "nativeName": string, "intl": string }` (the Intl tag, for example `fr-FR`). Its direction comes from the right to left list. On load, keys not in English are ignored; keys missing fall back to English.
- Caddy: a `handle /locales/*` block in `deploy/Caddyfile` with `root` and `file_server` and `Cache-Control: no-cache`, placed before the catch all proxy to `web`; `deploy/compose.yaml` mounts `extensions/<client>/locales` read only on the `caddy` service. If the folder is absent Caddy answers 404 and the language is simply hidden. There is no `public/locales` folder (it would be baked into locally built images); Playwright tests stub `/locales/<code>.json` with `page.route`.
- First render: the provider's server snapshot and first client render are English left to right. After hydration an effect applies the cookie language (loading its catalog first), then removes `data-i18n="pending"`. The hidden window therefore covers hydration time as well as the catalog fetch, so the 10 second cap is judged on a slow device.
- Switching: every choice gets a request token; only the latest token may apply, so a stale load is dropped. The inline error clears on the next menu open or choice.
- Default language unavailable: pick the first enabled language with a loadable catalog, else `en`.
- Slow config: a returning user whose cookie names a client language and whose config or file takes longer than the 10 second cap sees English, then it changes once. Accepted.
- Tabs: a change in one tab does not update other open tabs until they reload. Accepted.
- `loadConfig()` stops caching a failure: a failed call clears the cached promise so the next caller retries.

**Formatting options** (all in `format.ts`; digits always Western through `numberingSystem: 'latn'`; locale tag from the language; instants use the `timezone` setting, date only values use `timeZone: 'UTC'` on UTC midnight):

| Function | Input | Options | English example |
|---|---|---|---|
| `number` | number or decimal string | grouping on, up to 3 fraction digits | `1,234.5` |
| `quantity` | integer (spec 0002 `quantity int`) | grouping on, 0 fraction digits | `12,000` |
| `percent` | decimal string such as `"14.00"` | `style: 'unit'`, `unit: 'percent'`, up to 2 fraction digits | `14%` |
| `money` | decimal string, digits `2` or `4` | `style: 'currency'`, `currency` from settings, `currencyDisplay: 'symbol'`, minimum and maximum fraction digits both equal to `digits`, default rounding (half away from zero) | `EGP 1,234.50` |
| `date` | instant | day numeric, month short, year numeric | `4 Nov 2026` |
| `dateNumeric` | instant | day 2 digit, month 2 digit, year numeric | `04/11/2026` |
| `dateOnly` | `YYYY-MM-DD` | same options as `date`, UTC | `3 Nov 2026` |
| `time` | instant | hour and minute 2 digit; `hourCycle` `h23` for English, `h12` for Arabic | `00:30` |
| `dateTime` | instant | `date` and `time` options together | `4 Nov 2026, 00:30` |

Arabic output is pinned by the tests after the first run and read by an Arabic speaker; tests strip the invisible marks U+200E, U+200F, and U+061C before comparing. `number`, `quantity`, and `percent` need no settings and work before config loads. `money`, `date`, `dateNumeric`, `dateOnly`, `time`, and `dateTime` need `currency` or `timezone`; `format.ts` catches any `Intl` error and then sets `status` to `'error'`.

**API surface**:
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/config` (platform module) | GET | none | `clientName`, `version`, `currency?: string`, `timezone?: string`, `languages: string[]` (at least one), `defaultLanguage: string` | public (needed before sign in) | settings unreadable: still 200 with env fields and code defaults, error logged; a 5xx makes the web use its AC-4 fallback |
| `/locales/<code>.json` (Caddy, static) | GET | `<code>` | the catalog JSON | public | 404 when no such file (language hidden, AC-11) |

`ConfigResponse` in `packages/contracts` gains the four fields, with the defaults and optional fields described in AC-4. `ConfigController` injects `SettingsService` (already in `PlatformModule`) and its `read()` becomes async. If `default_language` is not in `languages`, the controller returns `languages[0]` as the default and logs a warning (never a 500). No new api messages are translated: the api keeps sending stable error codes and data only.

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| Switch language | list of languages and their names | `GET /api/config` `languages` ∩ core registry `nativeName` or runtime JSON `_meta.nativeName` |
| Switch language | the new language's text | `locales/ar.ts` chunk, or `/locales/<code>.json` for a client language |
| First paint | `lang` and `dir` | cookie `ss_lang`, read by the head script; direction from the right to left base code list |
| First visit | which language | `GET /api/config` `defaultLanguage` ← setting `default_language` |
| Any formatted number | digits, separators | language's Intl tag (`languages.ts` or `_meta.intl`) with `numberingSystem: 'latn'` |
| Money | currency code | `GET /api/config` `currency` ← setting `currency` |
| Money | decimal places | 2 for amounts, 4 for unit costs, passed by the caller; precision from the api's decimal string |
| Instant (timestamp) | displayed date and time | the instant from the api, shown in `GET /api/config` `timezone` ← setting `timezone` |
| Date only value | displayed date | the `YYYY-MM-DD` string, formatted as UTC midnight so it never shifts |
| English or Arabic clock | 24 hour or 12 hour | `hour12` in the registry (`_meta` has none, so client languages use their Intl tag default) |
| Bilingual stored text | which language's text | AC-9 order: active language, `defaultLanguage`, other enabled languages in order, then the code |
| Page tab title | title text | stays the product name "SSDashboard" (a proper name, not translated); per page titles belong to later features |
| Settings not yet loaded | formatted output | `money`, date, and time functions return the raw value string and `useFormat().status` is `'loading'` or `'error'`; a screen shows its own loading or error state, never a guessed time zone. `number`, `quantity`, and `percent` need no settings |

**Key invariants**:
- `<html lang>` and `<html dir>` always agree with the active language; Radix direction always agrees with `<html dir>`.
- English is always loaded, so a missing key never reaches the screen as a raw key.
- No text is rendered through `dangerouslySetInnerHTML` from a catalog.
- Every enabled language has a loadable catalog or is hidden; `languages` always holds at least one code.
- The cookie holds only a 2 to 3 letter code and is validated on both reads (head script, provider).

**Security model**: `GET /api/config` and `/locales/*` are public and hold nothing secret (language codes, currency, time zone, public translation text). The cookie carries only a language code and is checked against a strict pattern and the enabled list before use. Catalog text is rendered as text, never as HTML. Client JSON is trusted administrator content, still validated for shape. No personal data and no compliance scope.

**Configuration required**:
- Settings `languages` and `default_language` (migration seeds both); no new environment variable.
- `deploy/Caddyfile` and `deploy/compose.yaml`: the `/locales/*` block and the read only volume on the `caddy` service (see Runtime behaviours).

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: with cookie `ss_lang=ar`, the head script sets `dir="rtl"` and `lang="ar"` before first paint, Arabic text appears with no English flash, and the sidebar is on the right; switching to English flips it back without a reload and keeps text typed in an input, verifies **AC-1**, **AC-2**, **AC-3**.
- First visit: no cookie and `defaultLanguage: 'ar'` from a stubbed config gives Arabic and writes the cookie, verifies **AC-3**, **AC-4**.
- Failure: a saved `ss_lang=fr` that config no longer enables falls back to the default and rewrites the cookie; a failing `/api/config` keeps the saved language or English LTR, and a second call retries, verifies **AC-4**.
- Failure: the Arabic chunk request is blocked, so choosing Arabic leaves English active, the cookie unchanged, and an inline error shown, verifies **AC-13**.
- Hydration: loading with `ss_lang=ar` logs no hydration warning and ends in Arabic, verifies **AC-3**.
- Race: choosing Arabic then English quickly (or the reverse) while the first catalog is still loading ends in the last choice, verifies **AC-13**.
- Catalog parity: a Vitest test fails when `ar.ts` lacks an English key or a required plural form, verifies **AC-6**; a type test shows a wrong key fails `tsc`, verifies **AC-5**.
- Plurals: counts 0, 1, 2, 3, 11, 100 pick the six Arabic forms, and `{{name}}` interpolates in both, verifies **AC-7**.
- Formatting: `1234.5` as money gives `EGP 1,234.50` in English and the Arabic symbol with Western digits in Arabic; the string `"12.3456"` keeps all 4 decimals; `2026-11-03T22:30:00Z` in `Africa/Cairo` shows `4 Nov 2026, 00:30` (UTC+2) in English; a date only `2026-11-03` stays `3 Nov 2026`; an invalid `currency` setting is rejected when read, and a forced `Intl` error sets status `'error'`; plain `number` works before config loads, verifies **AC-8**.
- Lint: a fixture file with a raw JSX string, one with `toLocaleString`, and one with `new Intl.NumberFormat` each fail `lint`, verifies **AC-5**, **AC-8**.
- Localized text: `{ en: ' ', ar: 'المستودع' }` shows the Arabic name in English mode, an empty object shows the code, verifies **AC-9**.
- Client language: a fixture `fr.json` with `_meta` and half the keys appears in the menu, shows French where translated and English elsewhere; a malformed file is hidden with a console warning, verifies **AC-11**.
- Accessibility and layout: axe in the four theme by language combinations, and a 375px Arabic screenshot check for clipping, verifies **AC-12**.
- Bidi: `LtrText` around `SKU-A/12` inside Arabic text renders with a computed `direction: ltr`, verifies **AC-10**.

## Build plan (original, built)

Tracer Bullet: prove one real thread first (Arabic chosen, saved, restored before paint, mirrored), then thicken one segment at a time.

1. Thin thread: migration for `languages` and `default_language`, `SettingShapes`, `ConfigResponse` and `ConfigController` with the four new fields, `loadConfig` retry; `language-config.ts` and the head script with the hidden until ready rule; `LanguageProvider` with i18next, English bundled and a small real Arabic chunk (shell chrome only); the Language submenu replacing the Direction submenu; remove `DirectionBridge`, `direction-config.ts`, `ss_dir`, and delete `t.spec.ts` and `direction.spec.tsx` (replaced by provider tests), satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-13**
2. Full catalogs: move `messages.en.ts` to `locales/en.ts`, typed `useTranslation` and `MessageKey`, `SkipLink` client component, convert every `t()` call, write the complete Arabic catalog, add interpolation and plural examples, the parity test, and the English fallback, satisfies **AC-5**, **AC-6**, **AC-7**
3. Formatting and bilingual text: `format.ts`, `use-format.ts`, `localized-text.ts`, change `locationName()` in `current-location-provider.tsx` to the new rule, tighten `currency` and `timezone` in `SettingShapes`, add the `no-restricted-syntax` lint rule for `toLocale*` and `new Intl.*` (exempting `format.ts`, test specs, and e2e files), satisfies **AC-8**, **AC-9**
4. Enforcement and mixed text: `eslint-plugin-i18next` `no-literal-string` in markup only mode (confirm at install it fits the ESLint flat config; if not, a small script beside `check-logical-css.mjs`), `LtrText` in `packages/ui` plus `DESIGN.md` rules, satisfies **AC-5**, **AC-10**
5. Client languages: `runtime-languages.ts` with `_meta` validation, the Caddy `handle /locales/*` block and the read only volume on the `caddy` service in `deploy/`, the `extensions/README.md` note, a Playwright test that stubs `/locales/fr.json` with `page.route`, satisfies **AC-11**
6. Tests and docs: update the existing unit and Playwright tests that used `ss_dir` (set cookie `ss_lang` instead), axe and 375px Arabic checks, the production project now honouring the cookie, update `apps/web/AGENTS.md` and `packages/ui/DESIGN.md`, satisfies **AC-12** and re-verifies **AC-1** to **AC-4**

## Build plan

Amendment work only (the original plan above is built). Tracer Bullet: Milestone 1 moves one real thread through every process (a key in the shared catalog, read by the web and by the api's mail), then later milestones thicken one segment at a time.

**Milestone 1: The shared catalog, end to end**
1. [x] Create `packages/i18n` (package.json with the `.` and `./ar` exports, build to `dist` like `packages/contracts`, tsconfig, vitest, ESLint config, `README.md` from the module template, workspace and `catalog:` entries); move `apps/web/src/i18n/locales/en.ts` and `ar.ts`, `languages.ts`, `message-key.ts`, and `directionOf` and `RTL_LANGUAGES` into it; web imports from `@ssdashboard/i18n` and `apps/web/src/i18n/locales/` is deleted, satisfies **AC-14**
2. [x] `createTranslator` (async, English fallback, typed `t`) and `createTranslatorSync`; move the catalog parity and plural tests (counts 0, 1, 2, 3, 11, 100) into the package and extend parity to the new key groups, satisfies **AC-15**
3. [x] Add the `mail` keys and rewrite `apps/api/src/mail/mail-templates.ts` to render from `createTranslator`, deleting its `COPY` table; pin the old output with a snapshot test written before the change, satisfies **AC-15**
4. [x] A wrong key in `apps/api` fails `tsc` (fixture test like the web `typed-keys.spec.ts`); the extension locale e2e (`fr.json`) still passes, satisfies **AC-15**, **AC-23**

**Done when** `pnpm build && pnpm typecheck && pnpm --filter @ssdashboard/i18n test && pnpm --filter @ssdashboard/web test && pnpm --filter @ssdashboard/api test` all pass, and `pnpm lint` passes.

**Milestone 2: Formatting and digits at every edge**
1. [x] Move the nine formatters into `createFormatter({ language, currency, timezone })` in `packages/i18n` with their tests (the original AC-8 tests move, Arabic output stays pinned); `apps/web/src/i18n/use-format.ts` wraps it; delete `apps/web/src/i18n/format.ts`, satisfies **AC-19**
2. [x] Change the `no-restricted-syntax` lint rule exemption to `packages/i18n/src/`, extend it to `apps/api` and the worker, update the fixtures in `packages/config`, satisfies **AC-19**
3. [x] `normalizeDigits`, `parseQuantity`, `parseMoney` with the table tests from the critical scenarios; `westernDigits`, `quantityInput`, `moneyInput` in `packages/contracts`; apply them to the numeric fields of the existing stock receipt and SKU request schemas; a controller e2e posts an Arabic digit quantity, satisfies **AC-18**
4. [x] Display tests on the Cairo transition instants (spring 2026 and autumn 2026 rows) for `time`, `dateTime`, and `dateOnly`, and an EGP parity test between the web hook and `createFormatter`, satisfies **AC-19**, **AC-20**

**Done when** `pnpm typecheck && pnpm --filter @ssdashboard/i18n test && pnpm --filter @ssdashboard/contracts test && pnpm --filter @ssdashboard/web test && pnpm --filter @ssdashboard/api test && pnpm --filter @ssdashboard/config test && pnpm lint` all pass.

**Milestone 3: Server rendered portal and partner pages**
1. [x] Spike first: remove `app/layout.tsx`, give `(backoffice)` and `(auth)` their own root layouts from one `StaticRootFrame`, enable `experimental.globalNotFound` with `app/global-not-found.tsx`, and prove a production build still answers a real 404 for `/design` and for an unknown path. If it cannot, apply the fallback in the design delta and record that choice in this spec, satisfies **AC-17**
   > Spike result, 2026-11-05: the preferred route holds and the fallback was not used. With multiple root layouts and `experimental.globalNotFound` on Next.js 16.4.3, a production build answers a real 404 for `/design`, `/no-such-page`, and `/fr/returns`, and `/_not-found` still exists, so `proxy.ts` keeps rewriting to it. Two findings for builders: `next typegen` does not detect a root parameter under a route group (it reports no root params, so the `next/root-params` getter is untyped; `apps/web/src/i18n/root-language.ts` wraps it with a type), and a `notFound()` in a `[lang]` layout alone would stream a 200 under Cache Components, so `proxy.ts` owns the 404 for any first segment other than `en` and `ar` in front of `/returns` or `/partner` (widened 2026-11-06 after review: not only two or three letter codes; the back office sections `skus` and `stock-receipts` resolve to their own `[id]` routes and pass through), and the layouts keep `notFound()` as a second guard. One consequence for AC-17: `(auth)` and `(backoffice)` are now separate root layouts, so signing in or out is a full document load, and an Arabic user sees the hidden body wait once more after each sign in.
2. [x] Move `(portal)` and `(partner)` pages under `[lang]`, add their root layouts using `next/root-params`, `generateStaticParams` for `en` and `ar`, a 404 for any other `lang`, satisfies **AC-16**
3. [x] `proxy.ts`: redirect an unprefixed portal or partner path by cookie, then `Accept-Language`, then `ar`; refresh `ss_lang` on a prefixed path; keep the `x-pathname` header and the production `/design` 404; unit tests for the choice order, satisfies **AC-16**
4. [x] Server translator in the page frames, the other language link, the provider started with the page language and catalog (no effect swap, no hydration warning), and the Playwright tests: scripts disabled shows `lang="ar" dir="rtl"` and Arabic text, redirect, 404, axe in both languages at 375px, satisfies **AC-16**
5. [x] Re-run the original localization e2e on `(backoffice)` and `(auth)`, including the production project, satisfies **AC-17**

**Done when** `pnpm build && pnpm typecheck && pnpm --filter @ssdashboard/web test && pnpm test:e2e` all pass, and `node packages/config/scripts/check-route-groups.mjs` passes.

**Milestone 4: Operating day test and the time zone release step** (needs `ssd_operating_day(timestamptz)` from the data model, feature 4; start it after that migration lands)
1. [ ] Database test `packages/db/test/operating-day-dst.e2e-spec.ts` (name to match the existing e2e files there): the fixed 2026 table, the release year's two transitions computed from the rule, a check against Node `Intl` for every row, the 23 and 25 hour day counts, and a failure when the release year does not have exactly two offset changes, satisfies **AC-21**
2. [ ] Root script `check:timezone` (a file in `packages/config/scripts`) that prints `process.versions.tz`, `process.versions.icu`, and the PostgreSQL version, then runs the test; document it as a release step in `packages/i18n/README.md` for the feature 26 runbook, satisfies **AC-22**
3. [ ] Update the docs this changes: `packages/i18n/README.md`, `apps/web/src/i18n/README.md`, `apps/api/src/mail/README.md`, `extensions/README.md` (portal and mail use core languages only), satisfies **AC-23**

**Done when** `pnpm db:migrate && pnpm --filter @ssdashboard/db test:e2e && pnpm check:timezone && pnpm lint` all pass.

## Consequences

**Positive**:
- Switching language is instant, keeps form input, and mirrors portals correctly.
- One formatting module means every figure and date looks the same in every screen and matches exports.
- Typed keys, the parity test, and the literal string lint make missing or hard coded text a build failure.
- A new client language is a translation file plus a setting: no developer and no new image.

**Negative / tradeoffs**:
- English is always in the main bundle (it is the fallback and the type source), so the "only the active language downloads" idea applies to every other language.
- The first visit ever shows the default language only after config loads (a brief change); a returning non English user waits for the Arabic chunk behind a hidden body (up to 10 seconds if the network is slow, Slow 3G included).
- Client language JSON is not type checked at build; the load time check and English fallback are the only safety net.
- The language choice is per browser, not per user: a person on two devices picks twice until sign in (feature 6) adds an account preference.
- Arabic strings are typically longer or shorter than English; some later tables may need column width review.
- Hiding the body until ready relies on a script running before paint; with scripts blocked the page already cannot work. The hidden window includes hydration time, not only the catalog fetch.
- A language change in one browser tab does not reach other open tabs until they reload.
- On a slow network a returning user of a client language may see English for a moment after the 10 second cap, then one change.

**Neutral**:
- Amendment 2026-11-05: one catalog source for web, mail, and worker; portal and partner URLs carry `/en` or `/ar`; those two audiences and the back office are separate root layouts, so moving between them is a full page load; a client language works in the back office only until the server side loader follow-up is done; time zone data now has a named release check.
- Spec 0003's AC-11 (direction switch only in development, production always left to right) and AC-12 (English only dictionary) are replaced by this spec. `/sync` should mark them superseded in 0003's verify notes.
- New dependencies: `i18next`, `react-i18next` (versions pinned in the `catalog:`), and `eslint-plugin-i18next` (dev only). Check peer versions at install; the research recorded `react-i18next` 17.x with `i18next` 26.x and `next-intl` 4.x as of November 2026.
- Week start (English Monday, Arabic Saturday) and Hijri are recorded in the registry, but no date picker exists yet; the first feature that adds one uses `weekStart`.
- The api keeps sending only stable error codes; documents and emails (purchasing, sales) add their own templates later, reusing this catalog format.

## Follow-up

- [ ] When feature 6 (staff sign in) lands, store the language on the user account, keep `ss_lang` as the pre sign in value, and decide which wins after sign in.
- [ ] Feature 46 (client settings and module toggles) should offer an admin screen for `languages` and `default_language`, and decide the long term extension contract; until then the runtime JSON route in this spec is the only extension point for text.
  > Amended 2026-11-05: that is now scope feature 9, settings, module toggles and bundles ([spec 0009](../0009-settings-toggles-bundles/index.md)).
- [ ] Purchasing and sales documents (printed and emailed purchase orders, quotes) need a server side template language and catalog; decide it when feature 21 is designed. _Amended 2026-11-05: the catalog and translator are decided by Amendment AC-14 and AC-15; feature 21 only adds keys and templates._
- [ ] Amendment: a server side loader for client languages (read `extensions/<client>/locales` in the api, worker, and portal), so mail, reports, and the public pages can use a client language. Decide when a client asks for one.
- [ ] Amendment: measure the hidden body wait for a returning Arabic manager on Slow 4G (AC-17); if it is over 2 seconds, move the back office to a server rendered language too.
- [ ] Amendment: `/sync` should update `apps/web/AGENTS.md` and `apps/api/AGENTS.md` (the i18n key files move to `packages/i18n`, new `packages/i18n` entry in the root `AGENTS.md` context list), `packages/config/AGENTS.md` (the `Intl` lint exemption path), and the root `AGENTS.md` rule on audiences if `[lang]` segments change it.
- [ ] Date pickers and calendars (first feature that needs one) must read `weekStart` from the registry.
- [ ] `/sync` should mark spec 0003 AC-11 and AC-12 as superseded by this spec and update `apps/web/AGENTS.md` (the `Key files` table and the direction conventions).
- [ ] Verify at install that `eslint-plugin-i18next` `no-literal-string` works with the project's ESLint flat config and that wrong keys fail `tsc` with the chosen react-i18next typing; both were not confirmed in the research.
- [ ] Confirm the Caddy snippet and the compose volume against the real `deploy/` files when step 5 is built.
- [ ] Consider installing a community i18n skill if one matching `i18next` is published; none is installed today.
- [ ] `/architect`: specs 0005 (`index.md` lines 33, 91, 138; `verify.md` lines 451 to 454) and 0008 (`verify.md` line 13) still use unprefixed `/partner` and `/partner/account` URLs, and spec 0005 plans a partner Account language picker, which conflicts with AC-16 (the URL owns the language on partner pages). Amend both specs to the `/en` and `/ar` prefixes and decide what the picker becomes (found by the milestone 1 to 3 review, 2026-11-06).

## Rationale

Reasoning, options considered, and references: see [rationale.md](rationale.md).
