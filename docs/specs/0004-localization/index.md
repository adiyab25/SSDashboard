# 0004. Localize the back office with client side i18next, a language cookie, and one shared formatting module

**Date**: 2026-11-03
**Status**: In Progress

## Summary

This spec makes every screen work in English and Arabic and lets a user switch between them without reloading. The choice is saved in a browser cookie, so the page opens in the right language and direction before it paints. Numbers always use Western digits (0 to 9), dates read day, month, year in the install's own time zone, and money follows the install's currency. A client can add a third language by dropping one JSON translation file into `extensions/<client>/locales` and enabling it in settings, with no code change and no new web image. It replaces the development only direction switch from the design system spec.

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
- **AC-3**: With no cookie, the first visit shows the install default language from `GET /api/config`, then writes `ss_lang` so later visits need no wait (one brief language change on that first visit only is accepted). With a cookie, the inline script in `<head>` sets `lang` and `dir` before first paint, and for a language other than English it keeps the page body hidden until its catalog is applied (a 10 second cap, run by the script itself, so a failed load never leaves a blank page). A returning Arabic user never sees English text flash. The server snapshot and the first client render are always English left to right (matching the prerendered HTML); the cookie language is applied in an effect after hydration, behind the hidden body, so there is no hydration mismatch (a test checks that an Arabic load logs no hydration warning).
- **AC-4**: Settings rows `languages` (default `["en","ar"]`) and `default_language` (default `"en"`) exist after migration, and `GET /api/config` returns `languages`, `defaultLanguage`, `currency`, and `timezone` besides `clientName` and `version`. If the saved language is not enabled, the install default is used and the cookie is rewritten. If the config call fails, the saved language is kept when its catalog loads, else English left to right; the shell still works, and the next config read retries instead of caching the failure. If `default_language` is an enabled language whose catalog is missing or invalid, the first enabled language with a loadable catalog is used, else English, and the cookie is not written until a language actually applies. The new `ConfigResponse` fields have zod defaults (`languages` `['en']`, `defaultLanguage` `'en'`) and `currency` and `timezone` are optional, so an older api never breaks a newer web, and the two images may differ in version. If the api cannot read settings it still answers with `clientName`, `version`, and those defaults, and logs the error.
- **AC-5**: No UI string is hard coded. All text in `apps/web` comes through typed keys (a wrong key fails the type check), `packages/ui` takes text only through props, and `lint` fails on a raw literal in markup (JSX text and the `aria-label`, `title`, `placeholder`, and `alt` attributes), with development only `/design` specimens, test specs (`*.spec.ts` and `*.spec.tsx`), and e2e files exempt.
- **AC-6**: A test fails the build when the Arabic catalog lacks any English key (plural keys compared by the plural forms each language needs). At runtime a missing translation falls back to English; a raw key is never shown.
- **AC-7**: Interpolation (`{{name}}`) and plurals work in both languages. Arabic selects the right one of its six forms for counts 0, 1, 2, 3, 11, and 100 (checked with `Intl.PluralRules`, not hand written rules).
- **AC-8**: One module, `apps/web/src/i18n/format.ts`, formats numbers, integer quantities, percents, money, dates, times, and date and time values, each a named function with fixed `Intl` options (listed under Feature design, Formatting options). Digits are always Western. Decimal strings from the api are passed to `Intl` as strings, so a 4 decimal cost never loses precision. Money uses the `currency` setting with that language's Intl style (English `EGP 1,234.50`, Arabic with its own symbol). Instants display in the `timezone` setting for every user, day first; English uses a 24 hour clock, Arabic a 12 hour clock with ص/م. A date only value (`YYYY-MM-DD`) never shifts a day. `lint` fails on `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, or `new Intl.*` outside this module, test specs, and e2e files. An invalid `currency` or `timezone` setting is rejected when settings are read, and any remaining `Intl` error makes the formatting status `'error'` instead of crashing a screen.
- **AC-9**: Bilingual stored text (`{ en, ar }`, spec 0002) shows the active language, else the install default language, else any other non empty language in enabled order, else the code. Values are trimmed first. `locationName()` in `apps/web/src/shell/current-location.tsx` takes the active and default language and uses this rule instead of its current English first rule.
- **AC-10**: A shared `LtrText` component isolates codes (SKU, barcode, document number, email, URL) as left to right inside right to left text. `packages/ui/DESIGN.md` says to use it for every such value.
- **AC-11**: A client language is added by a file `extensions/<client>/locales/<code>.json` (with a `_meta` block holding the language's own name and its Intl tag) plus the code in the `languages` setting. The file is served by Caddy at `/locales/<code>.json` and fetched at runtime, with no change to the web image. Keys it lacks fall back to English. A file that is missing, malformed, or has no `_meta` hides that language from the switcher and logs a console warning; it never breaks the shell. A client language appears in the menu only after its file has loaded and validated, and the menu always keeps the `languages` order.
- **AC-12**: axe reports zero violations on the shell in Arabic and English. At 375px wide in Arabic nothing in the shell is clipped or overlapping, and Arabic text renders in IBM Plex Sans Arabic (spec 0003 AC-13 still holds).
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

## Build plan

Tracer Bullet: prove one real thread first (Arabic chosen, saved, restored before paint, mirrored), then thicken one segment at a time.

1. Thin thread: migration for `languages` and `default_language`, `SettingShapes`, `ConfigResponse` and `ConfigController` with the four new fields, `loadConfig` retry; `language-config.ts` and the head script with the hidden until ready rule; `LanguageProvider` with i18next, English bundled and a small real Arabic chunk (shell chrome only); the Language submenu replacing the Direction submenu; remove `DirectionBridge`, `direction-config.ts`, `ss_dir`, and delete `t.spec.ts` and `direction.spec.tsx` (replaced by provider tests), satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-13**
2. Full catalogs: move `messages.en.ts` to `locales/en.ts`, typed `useTranslation` and `MessageKey`, `SkipLink` client component, convert every `t()` call, write the complete Arabic catalog, add interpolation and plural examples, the parity test, and the English fallback, satisfies **AC-5**, **AC-6**, **AC-7**
3. Formatting and bilingual text: `format.ts`, `use-format.ts`, `localized-text.ts`, change `locationName()` in `current-location.tsx` to the new rule, tighten `currency` and `timezone` in `SettingShapes`, add the `no-restricted-syntax` lint rule for `toLocale*` and `new Intl.*` (exempting `format.ts`, test specs, and e2e files), satisfies **AC-8**, **AC-9**
4. Enforcement and mixed text: `eslint-plugin-i18next` `no-literal-string` in markup only mode (confirm at install it fits the ESLint flat config; if not, a small script beside `check-logical-css.mjs`), `LtrText` in `packages/ui` plus `DESIGN.md` rules, satisfies **AC-5**, **AC-10**
5. Client languages: `runtime-languages.ts` with `_meta` validation, the Caddy `handle /locales/*` block and the read only volume on the `caddy` service in `deploy/`, the `extensions/README.md` note, a Playwright test that stubs `/locales/fr.json` with `page.route`, satisfies **AC-11**
6. Tests and docs: update the existing unit and Playwright tests that used `ss_dir` (set cookie `ss_lang` instead), axe and 375px Arabic checks, the production project now honouring the cookie, update `apps/web/AGENTS.md` and `packages/ui/DESIGN.md`, satisfies **AC-12** and re-verifies **AC-1** to **AC-4**

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
- Spec 0003's AC-11 (direction switch only in development, production always left to right) and AC-12 (English only dictionary) are replaced by this spec. `/sync` should mark them superseded in 0003's verify notes.
- New dependencies: `i18next`, `react-i18next` (versions pinned in the `catalog:`), and `eslint-plugin-i18next` (dev only). Check peer versions at install; the research recorded `react-i18next` 17.x with `i18next` 26.x and `next-intl` 4.x as of November 2026.
- Week start (English Monday, Arabic Saturday) and Hijri are recorded in the registry, but no date picker exists yet; the first feature that adds one uses `weekStart`.
- The api keeps sending only stable error codes; documents and emails (purchasing, sales) add their own templates later, reusing this catalog format.

## Follow-up

- [ ] When feature 6 (staff sign in) lands, store the language on the user account, keep `ss_lang` as the pre sign in value, and decide which wins after sign in.
- [ ] Feature 46 (client settings and module toggles) should offer an admin screen for `languages` and `default_language`, and decide the long term extension contract; until then the runtime JSON route in this spec is the only extension point for text.
- [ ] Purchasing and sales documents (printed and emailed purchase orders, quotes) need a server side template language and catalog; decide it when feature 21 is designed.
- [ ] Date pickers and calendars (first feature that needs one) must read `weekStart` from the registry.
- [ ] `/sync` should mark spec 0003 AC-11 and AC-12 as superseded by this spec and update `apps/web/AGENTS.md` (the `Key files` table and the direction conventions).
- [ ] Verify at install that `eslint-plugin-i18next` `no-literal-string` works with the project's ESLint flat config and that wrong keys fail `tsc` with the chosen react-i18next typing; both were not confirmed in the research.
- [ ] Confirm the Caddy snippet and the compose volume against the real `deploy/` files when step 5 is built.
- [ ] Consider installing a community i18n skill if one matching `i18next` is published; none is installed today.

## Rationale

Reasoning, options considered, and references: see [rationale.md](rationale.md).
