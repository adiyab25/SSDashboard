# Verify: localization · spec 0004 · updated 2026-11-05 (amendment steps added)
_Steps derived from spec 0004 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Most already have a test: the unit tests in `apps/web/src/i18n`, `apps/web/src/shell`, `apps/api/src/platform`, `packages/config/eslint/i18n.test.mjs`, and `apps/web/e2e/localization.spec.ts`._

## UI / manual
- [x] Open the user menu → Language lists "English" and "العربية", each with its own `lang` and `dir` → AC-1
- [x] Choose العربية → all shell text, `<html lang>`, `<html dir>`, menus, popovers, and the sidebar flip with no reload; type in the `/design` search box first and confirm the text stays → AC-1, AC-2
- [x] Reload → the page opens in Arabic with no English flash (throttle the network to Slow 3G and watch the first paint) → AC-3
- [x] Clear cookies, set the `default_language` setting to `ar`, load → Arabic, and cookie `ss_lang=ar` is written → AC-3, AC-4
- [x] Set cookie `ss_lang=fr` (not enabled) → the page opens in the default language and the cookie is rewritten → AC-4
- [x] Block `/api/config` (offline) with `ss_lang=ar` set → Arabic stays; with no cookie → English left to right → AC-4
- [x] Block the Arabic chunk, then choose العربية → English stays, cookie unchanged, the error line appears under Language, and it clears when the menu is reopened → AC-13
- [x] Choose العربية then English quickly on a slow network → ends in English → AC-13
- [x] Load with `ss_lang=ar` and watch the console → no hydration warning → AC-3
- [x] Add `extensions/<client>/locales/fr.json` (with `_meta`) and `fr` to `languages` → "Français" appears; translated keys show French, the rest English → AC-11
- [x] Break that file (invalid JSON, or remove `_meta`) → the language is hidden, a console warning appears, the shell works → AC-11
- [x] At 375px wide in Arabic → no sideways scroll, header controls do not overlap; run axe in light and dark, English and Arabic → AC-12
- [x] In Arabic, the version on the home page keeps `0.0.0-dev` order (computed `direction: ltr`) → AC-10
- [ ] Ask an Arabic speaker to read the Arabic catalog and the Arabic money, date, and time output → AC-6, AC-8 (not done: the owner accepted the feature without this read on 2026-11-04; do it before a client in Arabic goes live)

## Value sourcing (vary the input and check the output)
- [x] Language list: change `languages` to `["en"]` → the menu shows only English → AC-4
- [x] First visit language: change `default_language` → a clean browser opens in it → AC-4
- [x] Money: change `currency` to `USD` → amounts show USD in both languages, 2 digits for amounts and 4 for unit costs → AC-8 (checked on the real format module, no screen uses it yet)
- [x] Instant: change `timezone` to `UTC` → `2026-11-03T22:30:00Z` shows `3 Nov 2026, 22:30` (Cairo shows `4 Nov 2026, 00:30`), the same for English and Arabic users → AC-8 (checked on the real format module, no screen uses it yet)
- [x] Date only value: a `YYYY-MM-DD` value shows the same day under every `timezone` → AC-8 (checked on the real format module, no screen uses it yet)
- [x] Clock: English reads 24 hour, Arabic 12 hour with ص/م → AC-8 (checked on the real format module, no screen uses it yet)
- [x] Bilingual name: a location with only an Arabic name shows it in English mode; with no names it shows its code → AC-9 (driven on 2026-11-04 by `bilingual-location.spec.ts`)
- [x] Digits: Arabic shows Western digits for numbers, quantities, percents, money, and dates → AC-8 (checked on the real format module, no screen uses it yet)

## Commands
- [x] `pnpm lint` → passes, and a raw JSX string, `toLocaleString`, or `new Intl.NumberFormat` outside `packages/i18n/src/format.ts` (and `plural-categories.ts`) fails it, in the web and the api (amended 2026-11-05, AC-19) → AC-5, AC-8
- [x] `pnpm typecheck` → passes, and a wrong `t('...')` key fails (`typed-keys.spec.ts`) → AC-5
- [x] `pnpm --filter @ssdashboard/web test` → catalog parity, plurals (0, 1, 2, 3, 11, 100), formatting, localized text, provider → AC-6, AC-7, AC-8, AC-9
- [x] `pnpm --filter @ssdashboard/config test` → lint fixtures fail where they should → AC-5, AC-8
- [x] `pnpm --filter @ssdashboard/api test` → config endpoint defaults and settings validation → AC-4
- [x] `pnpm db:migrate` then `select key, value from settings` → `languages` and `default_language` exist and re-running keeps edited values → AC-4
- [x] `pnpm test:e2e` (desktop, mobile, production projects) → all pass; production honours the cookie → AC-2
- [x] `docker run ... caddy validate` on `deploy/Caddyfile`, then `curl /locales/<code>.json` → 200 with `Cache-Control: no-cache`; a missing file is 404 → AC-11

## Acceptance-criteria coverage
- AC-1 … Language menu, switch without reload · AC-2 … direction follows language, dev switch gone · AC-3 … cookie, head script, no flash, no hydration warning · AC-4 … settings, config fallbacks · AC-5 … typed keys, literal string lint · AC-6 … catalog parity, English fallback · AC-7 … plurals and interpolation · AC-8 … formatting module and lint ban · AC-9 … bilingual text rule · AC-10 … LtrText · AC-11 … client language files and Caddy route · AC-12 … axe and 375px Arabic · AC-13 … load failure and overlapping choices

## Amendment 2026-11-05: verify steps (not yet run)

_Steps for AC-14 to AC-23. The checks above stay valid for `(backoffice)` and `(auth)` (AC-17) and must be re-run after milestone 3. `/check verify` runs these after the amendment is built._

### UI / manual
- [ ] Open `/ar/returns` with JavaScript disabled → `<html lang="ar" dir="rtl">`, Arabic text, no hidden body → AC-16
- [ ] Open `/returns` with `Accept-Language: ar-EG` and no cookie → redirected to `/ar/returns`; with cookie `ss_lang=en` → `/en/returns`; with neither → `/ar/returns` (or the owner's answer to question 1) → AC-16
- [ ] Open `/fr/returns` → real 404 → AC-16
- [ ] On a portal page, use the other language link → the same page in the other language, cookie `ss_lang` updated → AC-16
- [ ] Do the same three checks on a partner page → AC-16
- [ ] Production build: `/design` still answers 404, and an unknown path shows the not found page → AC-17
- [ ] Sign in and use the back office in Arabic as before (cookie, no flash, Language menu) → AC-17
- [ ] Type `٣` in a quantity field and `١٢٣٤٫٥٠` in an amount field (when a screen with each exists) → saved as `3` and `1234.50`; `1,5` shows a field error → AC-18
- [ ] Type a password containing Arabic digits → it is not changed → AC-18
- [ ] Send a password reset mail in Arabic → same text as before the move, right to left → AC-15
- [ ] Ask an Arabic speaker to read the new `mail`, `report`, `export`, and `receipt` text, together with the open item above → AC-15

### Value sourcing
- [ ] Change `currency` to `USD` → web, mail, and worker output all show USD; back to `EGP` → all show EGP → AC-19
- [ ] Change `timezone` to `UTC` → the same instant shows the UTC time in web and worker output → AC-20
- [ ] Display `2026-04-23T22:00:00Z` → `01:00` on 24 Apr 2026; `2026-10-29T20:30:00Z` and `2026-10-29T21:30:00Z` → both `23:30` on 29 Oct 2026 → AC-20
- [ ] `ssd_operating_day()` on the seven 2026 rows in the amendment → the dates listed there → AC-21

### Commands
- [ ] `pnpm --filter @ssdashboard/i18n test` → parity across all key groups, plurals, formatters, digit parsers → AC-14, AC-15, AC-18, AC-19
- [ ] `pnpm --filter @ssdashboard/contracts test` → the digit helpers on request schemas → AC-18
- [ ] `pnpm --filter @ssdashboard/api test` → mail snapshot, wrong key fixture, Arabic digit quantity → AC-15, AC-18
- [ ] `pnpm lint` → a `toLocaleString` or `new Intl.*` in `apps/api` fails it; `packages/i18n/src` is exempt → AC-19
- [ ] `node packages/config/scripts/check-route-groups.mjs` → still only the four audiences → AC-16
- [ ] `pnpm test:e2e` (desktop, mobile, production) → portal and partner server rendered tests, back office tests → AC-16, AC-17
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → operating day on the Cairo transition dates → AC-21
- [ ] `pnpm check:timezone` → prints `process.versions.tz`, `process.versions.icu`, the PostgreSQL version, and passes → AC-22
- [ ] The `fr.json` extension test, then a portal page with a French cookie → English → AC-23

### Acceptance-criteria coverage (amendment)
- AC-14 … shared package and imports · AC-15 … translator, typed keys, parity, mail snapshot · AC-16 … portal and partner server rendered by URL language · AC-17 … back office unchanged, root layouts split · AC-18 … Arabic digits at every edge · AC-19 … shared formatters, EGP, lint ban moved · AC-20 … Cairo display on transition instants · AC-21 … operating day test on real DST dates · AC-22 … time zone refresh release check · AC-23 … extension locales carried

## Verify run 2026-11-04 (after staff sign in, spec 0005, merged)

_Run by the QA tester with `/check verify localization` on branch `feat/finish-foundations`. Real api (`node dist/main.js`, port 3211), `next dev` (port 3210) and `next start` on a fresh production build (port 3212), against a throwaway Postgres database `ssdashboard_e2e_l10n_qa` on the local compose database (dropped afterwards). Every shell page needs a session now, so the Playwright suite signs in as the seeded e2e admin through `global-setup.ts`._

Verdict: PASS on all 13 acceptance criteria. One item stays open for a person: the Arabic reading review (see the end).

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 Language submenu, switch without reload, text kept, cookie | PASS | `localization.spec.ts` › "switching flips lang, dir, and portals without a reload, keeps typed text, and survives a reload" (desktop, passed) |
| AC-2 Direction follows language, dev switch gone, production honours cookie | PASS | `production.spec.ts` › "honours the saved language, with no development direction switch" (production project, passed on `next start`); `pnpm build` passes and `/design` is a real 404 in production |
| AC-3 Cookie, head script, no flash, no hydration warning | PASS | `localization.spec.ts` › "a saved Arabic page opens right to left with no English flash and no hydration warning"; "a first visit opens in the install default language and remembers it" (both passed, desktop) |
| AC-4 Settings, `/api/config`, fallbacks | PASS | Live: `GET /api/config` returned `languages`, `defaultLanguage`, `currency`, `timezone`. Changing `languages` to `["en"]` gave `["en"]`; `default_language` `"ar"` gave `"ar"`; `default_language` `"fr"` (not enabled) gave `"en"`. `pnpm db:migrate` seeded `languages` `["en","ar"]` and `default_language` `"en"`; after setting `ar` and re-running `node dist/migrate.js` the value stayed `"ar"`. e2e: "a saved language the install no longer enables falls back to the default" and "keeps the saved language when the config call fails" passed. `pnpm --filter @ssdashboard/api test` 305 passed |
| AC-5 Typed keys, no raw strings | PASS | `pnpm --filter @ssdashboard/web test` includes `typed-keys.spec.ts`, 341 passed; `pnpm --filter @ssdashboard/web lint` exit 0; `pnpm --filter @ssdashboard/config test` 19 pass, 0 fail (the lint fixtures fail where they should); `pnpm typecheck` 7 of 7 tasks successful |
| AC-6 Catalog parity, English fallback | PASS | `catalog.spec.ts` in the web unit run (341 passed). Wording quality is not judged here, see the open item |
| AC-7 Interpolation and plurals | PASS | `plurals.spec.ts` in the web unit run (341 passed) |
| AC-8 Formatting module and lint ban | PASS | `format.spec.ts` and `use-format.spec.tsx` in the web unit run; config lint fixtures for `toLocaleString` and `new Intl.*` pass. No screen uses money or dates yet, so these were checked on the module only (as in the earlier run) |
| AC-9 Bilingual stored text | PASS | `localized-text.spec.ts` and `location-switcher.spec.tsx` (unit). New driven check `apps/web/e2e/bilingual-location.spec.ts` (desktop, 2 passed): in English a location named only in Arabic shows the Arabic name, in Arabic an English only name shows, a location with no names shows its code |
| AC-10 `LtrText` | PASS | `localization.spec.ts` › "a code stays left to right inside right to left text (AC-10)" passed |
| AC-11 Client language files and Caddy | PASS | e2e "a language file appears in the menu, shows where translated and English elsewhere" and "a malformed or missing file is hidden with a console warning, and the shell works" passed. `caddy validate` on the real `deploy/Caddyfile` (with `SITE_ADDRESS=:80`) printed "Valid configuration". A Caddy container with the same `handle /locales/*` block: `/locales/fr.json` answered `200` with `Cache-Control: no-cache`, `/locales/xx.json` answered `404` |
| AC-12 axe and 375px Arabic | PASS | `shell.spec.ts` axe loop over theme and direction (passed); `localization.spec.ts` › "at 375px in Arabic nothing in the shell is clipped or overlapping" (mobile) and "Arabic text uses IBM Plex Sans Arabic" passed |
| AC-13 Load failure and overlapping choices | PASS | `localization.spec.ts` › "a blocked Arabic chunk keeps English, leaves the cookie, and shows an inline error" and "the last of two overlapping choices wins" passed |

Commands run (key lines):
- `pnpm build` → `Tasks: 4 successful`
- `pnpm typecheck` → `Tasks: 7 successful, 7 total`
- `pnpm --filter @ssdashboard/web test` → `Test Files 38 passed (38)`, `Tests 341 passed (341)`
- `pnpm --filter @ssdashboard/config test` → `# pass 19`, `# fail 0`
- `pnpm --filter @ssdashboard/api test` → `Test Files 27 passed (27)`, `Tests 305 passed (305)`
- `pnpm --filter @ssdashboard/web lint` → exit 0
- `playwright test` (desktop, mobile, production, whole suite) → `280 passed`, `44 skipped`, `1 failed` on the first pass. The failure was `shell.spec.ts:134` "every focused shell control shows a visible focus ring" (spec 0003, not localization). It passed when re-run alone, together with `localization.spec.ts` (`13 passed`); treat it as a possible flake, see follow-ups.
- Mobile skips are by design (`desktopOnly` and the 375px test runs on the mobile project only).

Not localization bugs, found along the way (not fixed, outside this lane):
- `pnpm lint` fails in `@ssdashboard/api` with 3 `no-unsafe-*` errors (`no-unsafe-return`, `no-unsafe-assignment`, `no-unsafe-member-access` on `.user_id`). The files in progress at the time are the spec 0005 work (`apps/api/src/auth`, `create-admin.ts`, `apps/api/test/create-admin-two-factor.e2e-spec.ts`), so this is the backend dev's in progress work. Web, ui and config lint are clean.
- With `API_INTERNAL_URL` set in the shell, `session-gate.spec.tsx` › "asks the api for the person with the cookie forwarded" fails because the test expects the default `http://localhost:3001`. It passes with the variable unset (38 of 38 files). A test hygiene issue for spec 0005's owner.

Still open (needs a person): ask an Arabic speaker to read the Arabic catalog and the Arabic money, date, and time output (AC-6, AC-8 wording). The Arabic reading box above stays unticked on purpose.
