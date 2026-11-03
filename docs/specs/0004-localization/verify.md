# Verify: localization · spec 0004 · updated 2026-11-03
_Steps derived from spec 0004 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Most already have a test: the unit tests in `apps/web/src/i18n`, `apps/web/src/shell`, `apps/api/src/platform`, `packages/config/eslint/i18n.test.mjs`, and `apps/web/e2e/localization.spec.ts`._

## UI / manual
- [x] Open the user menu → Language lists "English" and "العربية", each with its own `lang` and `dir` → AC-1
- [x] Choose العربية → all shell text, `<html lang>`, `<html dir>`, menus, popovers, and the sidebar flip with no reload; type in the `/design` search box first and confirm the text stays → AC-1, AC-2
- [ ] Reload → the page opens in Arabic with no English flash (throttle the network to Slow 3G and watch the first paint) → AC-3
- [x] Clear cookies, set the `default_language` setting to `ar`, load → Arabic, and cookie `ss_lang=ar` is written → AC-3, AC-4
- [x] Set cookie `ss_lang=fr` (not enabled) → the page opens in the default language and the cookie is rewritten → AC-4
- [x] Block `/api/config` (offline) with `ss_lang=ar` set → Arabic stays; with no cookie → English left to right → AC-4
- [x] Block the Arabic chunk, then choose العربية → English stays, cookie unchanged, the error line appears under Language, and it clears when the menu is reopened → AC-13
- [x] Choose العربية then English quickly on a slow network → ends in English → AC-13
- [x] Load with `ss_lang=ar` and watch the console → no hydration warning → AC-3
- [ ] Add `extensions/<client>/locales/fr.json` (with `_meta`) and `fr` to `languages` → "Français" appears; translated keys show French, the rest English → AC-11
- [x] Break that file (invalid JSON, or remove `_meta`) → the language is hidden, a console warning appears, the shell works → AC-11
- [x] At 375px wide in Arabic → no sideways scroll, header controls do not overlap; run axe in light and dark, English and Arabic → AC-12
- [x] In Arabic, the version on the home page keeps `0.0.0-dev` order (computed `direction: ltr`) → AC-10
- [ ] Ask an Arabic speaker to read the Arabic catalog and the Arabic money, date, and time output → AC-6, AC-8

## Value sourcing (vary the input and check the output)
- [x] Language list: change `languages` to `["en"]` → the menu shows only English → AC-4
- [x] First visit language: change `default_language` → a clean browser opens in it → AC-4
- [ ] Money: change `currency` to `USD` → amounts show USD in both languages, 2 digits for amounts and 4 for unit costs → AC-8
- [ ] Instant: change `timezone` to `UTC` → `2026-11-03T22:30:00Z` shows `3 Nov 2026, 22:30` (Cairo shows `4 Nov 2026, 00:30`), the same for English and Arabic users → AC-8
- [ ] Date only value: a `YYYY-MM-DD` value shows the same day under every `timezone` → AC-8
- [ ] Clock: English reads 24 hour, Arabic 12 hour with ص/م → AC-8
- [ ] Bilingual name: a location with only an Arabic name shows it in English mode; with no names it shows its code → AC-9
- [ ] Digits: Arabic shows Western digits for numbers, quantities, percents, money, and dates → AC-8

## Commands
- [x] `pnpm lint` → passes, and a raw JSX string, `toLocaleString`, or `new Intl.NumberFormat` outside `format.ts` fails it → AC-5, AC-8
- [x] `pnpm typecheck` → passes, and a wrong `t('...')` key fails (`typed-keys.spec.ts`) → AC-5
- [x] `pnpm --filter @ssdashboard/web test` → catalog parity, plurals (0, 1, 2, 3, 11, 100), formatting, localized text, provider → AC-6, AC-7, AC-8, AC-9
- [x] `pnpm --filter @ssdashboard/config test` → lint fixtures fail where they should → AC-5, AC-8
- [x] `pnpm --filter @ssdashboard/api test` → config endpoint defaults and settings validation → AC-4
- [x] `pnpm db:migrate` then `select key, value from settings` → `languages` and `default_language` exist and re-running keeps edited values → AC-4
- [x] `pnpm test:e2e` (desktop, mobile, production projects) → all pass; production honours the cookie → AC-2
- [ ] `docker run ... caddy validate` on `deploy/Caddyfile`, then `curl /locales/<code>.json` → 200 with `Cache-Control: no-cache`; a missing file is 404 → AC-11

## Acceptance-criteria coverage
- AC-1 … Language menu, switch without reload · AC-2 … direction follows language, dev switch gone · AC-3 … cookie, head script, no flash, no hydration warning · AC-4 … settings, config fallbacks · AC-5 … typed keys, literal string lint · AC-6 … catalog parity, English fallback · AC-7 … plurals and interpolation · AC-8 … formatting module and lint ban · AC-9 … bilingual text rule · AC-10 … LtrText · AC-11 … client language files and Caddy route · AC-12 … axe and 375px Arabic · AC-13 … load failure and overlapping choices
