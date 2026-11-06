<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# apps/web

## Overview

The Next.js App Router back office. Every staff page renders inside the app shell (`src/shell/`); the sign in screens (`(auth)`) and the `(portal)` and `(partner)` seams are documented exceptions with their own minimal frame. Built from `@ssdashboard/ui` to [`packages/ui/DESIGN.md`](../../packages/ui/DESIGN.md). Decisions: [spec 0003](../../docs/specs/0003-design-system-ui-foundation/index.md) (design system), [spec 0004](../../docs/specs/0004-localization/index.md) (localization).

## Key files

| File                                      | Owns                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shell/static-root-frame.tsx`         | The static document of `(backoffice)` and `(auth)`: fonts (`root-fonts.ts`: Inter, Noto Sans Arabic, JetBrains Mono, variable files, licenses in `public/licenses/fonts/`), the language head script, `Providers`, `SkipLink`. There is no `src/app/layout.tsx`: every audience group has its own root layout. Keep the `<Activity mode="visible">` around the frame: with Cache Components it restores the hydration boundary Next adds to a nested segment, without it a tap or typed text right after the page shows is lost on mobile                                                                                                                                                                                                                |
| `src/shell/public-root-frame.tsx`         | The document of `(portal)` and `(partner)`: `<html lang dir>` from the URL language on the server, `Providers` started in that language, `SkipLink`; no `main` (each page draws `PortalFrame` or `PartnerFrame`, which owns `main#main-content`)                                                                                                                                                                                                                                    |
| `src/app/global-not-found.tsx`            | The 404 document for any unmatched URL (experimental `globalNotFound`, needed because there are several root layouts); English, no business data                                                                                                                                                                                                                                                            |
| `src/app/(portal)/[lang]/layout.tsx`      | Root layout of the portal (the partner one is alike): reads `lang` from `next/root-params`, `generateStaticParams` for `en` and `ar`, renders `PublicRootFrame`                                                                                                                                                                                                                                             |
| `src/app/(backoffice)/layout.tsx`         | Root layout of the back office: `StaticRootFrame`, `CurrentLocationProvider` (calls staff `/api/locations`), `AppShell`, and the staff `SessionGate`                                                                                                                                                                                                                                                        |
| `src/app/providers.tsx`                   | Theme (`next-themes`), query client, language and direction (`LanguageProvider`), tooltips, toaster; nothing that calls a staff api route                                                                                                                                                                                                                                                                   |
| `src/shell/nav.ts`                        | The typed navigation registry the sidebar and command palette read                                                                                                                                                                                                                                                                                                                                          |
| `src/shell/current-location-provider.tsx` | `useCurrentLocation()` and the `ss_location` cookie                                                                                                                                                                                                                                                                                                                                                         |
| `@ssdashboard/i18n` (`packages/i18n`)     | Every UI string (`en` is the source, the type source, and the fallback; `@ssdashboard/i18n/ar` is a lazy chunk), the language registry, `directionOf`, and the translator the api mail also uses                                                                                                                                                                                                            |
| `src/i18n/language-provider.tsx`          | Active language, catalog loading, `<html lang dir>`, Radix direction, the `ss_lang` cookie                                                                                                                                                                                                                                                                                                                  |
| `src/i18n/language-config.ts`             | Cookie name, language code pattern, and the head script text (a plain module)                                                                                                                                                                                                                                                                                                                               |
| `src/i18n/use-format.ts`                  | `useFormat()`: `createFormatter` from `@ssdashboard/i18n` with the settings from `/api/config`, plus `status`                                                                                                                                                                                                                                                                                               |
| `src/i18n/localized-text.ts`              | Which language's text to show for `{ en, ar }` stored text                                                                                                                                                                                                                                                                                                                                                  |
| `src/i18n/runtime-languages.ts`           | Loads and checks client language files from `/locales/<code>.json`                                                                                                                                                                                                                                                                                                                                          |
| `src/design/`                             | The development only `/design` gallery (`design-gallery.tsx`, loaded through `design-loader.tsx`) and the frame previews it shows in iframes                                                                                                                                                                                                                                                                                                           |
| `src/proxy.ts`                            | Next.js Proxy: sets `x-pathname` for the session check `returnTo`; answers a real 404 for development only paths in production (`/design` and the frame previews `/<lang>/returns/preview/*`, `/<lang>/partner/preview`) and for a portal or partner path whose first segment is not exactly `en` or `ar` (back office `skus` and `stock-receipts` excepted); redirects (307) an unprefixed `/returns` or `/partner` to `/en` or `/ar` (cookie `ss_lang` when `en` or `ar`, `en` when it is another language code, else `Accept-Language` when the cookie is absent or not a code, then `ar`; sent `Cache-Control: private, no-store`); refreshes `ss_lang` on a prefixed path only when it is absent or `en`/`ar`. Not an authorization layer |
| `src/api/client.ts`                       | `apiRequest` (calls a relative `/api` path through `apiFetch` and parses the answer with a contract schema), `ApiError` with the stable error `code`, `withBusyRetry`                                                                                                                                                                                                                                       |
| `src/auth/api-fetch.ts`                   | `apiFetch`: `fetch` for session calls; a 401 sends the person to sign in, a 403 `PASSWORD_CHANGE_REQUIRED` to change password                                                                                                                                                                                                                                                                               |

## Route groups

One group per audience (spec 0007, section 2). The root `Providers` must stay free of staff api calls, because a 401 sends the browser to staff sign in.

- `(backoffice)`: staff back office, inside the app shell with the session check.
- `(auth)`: staff sign in screens, no shell.
- `(partner)`: consignment partners (`/en/partner`, `/ar/partner`, and the shared account screen at `/en/partner/account`), staff host, `PartnerFrame`, no staff shell. Sign in lands a partner here from `home` (spec 0005, AC-28); the account screen reads and saves through `/api/partner/me` (spec 0008) and pages still have no session gate of their own.
- `(portal)`: the public exchange and return portal (`/en/returns`, `/ar/returns`), `PortalFrame`, anonymous.

Each group is its own root layout (spec 0004), so moving between audiences is a full page load. `(portal)` and `(partner)` sit under a `[lang]` segment (`en` or `ar`): the server renders `<html lang dir>` and the page text in that language, with no head script and no hidden body, and each page has a plain `<a>` to the other language (`src/i18n/other-language-link.tsx`). Read the language with `pageLanguage()` (`src/i18n/page-language.ts`) in pages; never reflect the raw segment (`matchPublicLanguage` first). `/design` and unknown paths answer a real 404 through `global-not-found.tsx`.

## Commands

```bash
pnpm --filter @ssdashboard/web test        # Vitest + Testing Library (src/**/*.spec.tsx)
pnpm --filter @ssdashboard/web test:e2e    # Playwright: desktop, mobile, and production projects
```

- The production project runs `next start` on the last build (`E2E_PROD_PORT`, default 3100); build first. Point the suite at servers that are already running with `E2E_BASE_URL` and `E2E_PROD_BASE_URL`.
- Open the dev server on `localhost`, not `127.0.0.1`: Next dev blocks its own scripts for other origins, so the page never hydrates.

## Conventions

- Feature folders sit in `src/<feature>/` (`catalog`, `inventory`, `staff`, `account`, `partner`, `portal`, ...), each with a `README.md` (checked by `pnpm lint:repo`); route files in `src/app/<group>/` stay thin and render the feature's page component (`catalog/sku-detail-page.tsx`).
- One component per `.tsx` file, exporting the component named after the file; `lint` (`react/no-multi-comp`) and `pnpm lint:repo` (component export names) enforce it.
- No hard coded UI text: add the string to `packages/i18n/src/locales/en.ts` and the Arabic one to `packages/i18n/src/locales/ar.ts` (the parity test in `@ssdashboard/i18n` fails if a key is missing), and read it with `const { t } = useTranslation()`; a wrong key fails the type check. `lint` fails on a raw literal in JSX text and in `aria-label`, `title`, `placeholder`, and `alt`. Plural keys end in `_one`/`_other` (Arabic needs all six forms).
- Numbers, money, and dates go through `useFormat()` (Western digits in both languages, the install's currency and time zone). `lint` fails on `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, and `new Intl.*` outside `packages/i18n/src` (the formatters are `createFormatter`). Settings not loaded yet: `useFormat().status` is `loading` or `error` and the output is the raw value.
- Codes (SKU, barcode, document number, email, URL, version) sit in `LtrText` from `@ssdashboard/ui`. Stored `{ en, ar }` text goes through `localizedText()`.
- A client adds a language with `extensions/<client>/locales/<code>.json` and the `languages` setting; see `extensions/README.md`.
- A page joins the sidebar and palette by adding an entry to `navItems` in `src/shell/nav.ts` (`devOnly` for development only pages).
- Business data loads in client components on relative `/api` paths; browser state (theme, language, sidebar, location) is read on the client, never with `cookies()` in a layout. For `(backoffice)` and `(auth)` the server markup is always English left to right and the saved language is applied after hydration; `(portal)` and `(partner)` render their language on the server from the URL.
- A server file that needs a value from shell code imports it from a plain module (like `src/i18n/language-config.ts`), never from a `'use client'` file: there it gets a client reference, not the value.
- Development only code (`/design`) sits behind `process.env.NODE_ENV !== 'production'` and loads through `import()` in a client component, so production bundles drop it.

## Agent skills

- [nextjs-app-router-patterns](../../.claude/skills/nextjs-app-router-patterns/): `wshobson/agents`, App Router, server and client components
- [vercel-react-best-practices](../../.claude/skills/vercel-react-best-practices/): React and Next.js performance guidance
- [playwright-best-practices](../../.claude/skills/playwright-best-practices/): `currents-dev/playwright-best-practices-skill`, the `e2e/` suite: locators, waiting, projects, axe checks

_Drafted by /sync from the design system change, worth a quick human pass._
