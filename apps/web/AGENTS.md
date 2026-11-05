<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# apps/web

## Overview

The Next.js App Router back office. Every staff page renders inside the app shell (`src/shell/`); the sign in screens (`(auth)`) and the `(portal)` and `(partner)` seams are documented exceptions with their own minimal frame. Built from `@ssdashboard/ui` to [`packages/ui/DESIGN.md`](../../packages/ui/DESIGN.md). Decisions: [spec 0003](../../docs/specs/0003-design-system-ui-foundation/index.md) (design system), [spec 0004](../../docs/specs/0004-localization/index.md) (localization).

## Key files

| File | Owns |
|---|---|
| `src/app/layout.tsx` | Static root layout: fonts, the language head script, `Providers`, `SkipLink` |
| `src/app/(backoffice)/layout.tsx` | `CurrentLocationProvider` (calls staff `/api/locations`), `AppShell`, and the staff `SessionGate` |
| `src/app/providers.tsx` | Theme (`next-themes`), query client, language and direction (`LanguageProvider`), tooltips, toaster; nothing that calls a staff api route |
| `src/shell/nav.ts` | The typed navigation registry the sidebar and command palette read |
| `src/shell/current-location-provider.tsx` | `useCurrentLocation()` and the `ss_location` cookie |
| `src/i18n/locales/en.ts`, `locales/ar.ts` | Every UI string. English is the source, the type source, and the fallback; Arabic is a lazy chunk |
| `src/i18n/language-provider.tsx` | Active language, catalog loading, `<html lang dir>`, Radix direction, the `ss_lang` cookie |
| `src/i18n/language-config.ts` | Cookie name, right to left codes, and the head script text (a plain module) |
| `src/i18n/format.ts`, `use-format.ts` | The only place `Intl` is built: number, quantity, percent, money, date and time formatters |
| `src/i18n/localized-text.ts` | Which language's text to show for `{ en, ar }` stored text |
| `src/i18n/runtime-languages.ts` | Loads and checks client language files from `/locales/<code>.json` |
| `src/design/` | The development only `/design` gallery |

## Route groups

One group per audience (spec 0007, section 2). The root `Providers` must stay free of staff api calls, because a 401 sends the browser to staff sign in.

- `(backoffice)`: staff back office, inside the app shell with the session check.
- `(auth)`: staff sign in screens, no shell.
- `(partner)`: consignment partners (`/partner`), staff host, minimal frame, no staff shell or session check yet.
- `(portal)`: the public exchange and return portal (`/returns`), minimal frame, anonymous.

## Commands

```bash
pnpm --filter @ssdashboard/web test        # Vitest + Testing Library (src/**/*.spec.tsx)
pnpm --filter @ssdashboard/web test:e2e    # Playwright: desktop, mobile, and production projects
```

- The production project runs `next start` on the last build (`E2E_PROD_PORT`, default 3100); build first. Point the suite at servers that are already running with `E2E_BASE_URL` and `E2E_PROD_BASE_URL`.
- Open the dev server on `localhost`, not `127.0.0.1`: Next dev blocks its own scripts for other origins, so the page never hydrates.

## Conventions

- No hard coded UI text: add the string to `locales/en.ts` and the Arabic one to `locales/ar.ts` (a test fails if a key is missing), and read it with `const { t } = useTranslation()`; a wrong key fails the type check. `lint` fails on a raw literal in JSX text and in `aria-label`, `title`, `placeholder`, and `alt`. Plural keys end in `_one`/`_other` (Arabic needs all six forms).
- Numbers, money, and dates go through `useFormat()` (Western digits in both languages, the install's currency and time zone). `lint` fails on `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, and `new Intl.*` outside `src/i18n/format.ts`. Settings not loaded yet: `useFormat().status` is `loading` or `error` and the output is the raw value.
- Codes (SKU, barcode, document number, email, URL, version) sit in `LtrText` from `@ssdashboard/ui`. Stored `{ en, ar }` text goes through `localizedText()`.
- A client adds a language with `extensions/<client>/locales/<code>.json` and the `languages` setting; see `extensions/README.md`.
- A page joins the sidebar and palette by adding an entry to `navItems` in `src/shell/nav.ts` (`devOnly` for development only pages).
- Business data loads in client components on relative `/api` paths; browser state (theme, language, sidebar, location) is read on the client, never with `cookies()` in a layout. The server markup is always English left to right; the saved language is applied after hydration.
- A server file that needs a value from shell code imports it from a plain module (like `src/i18n/language-config.ts`), never from a `'use client'` file: there it gets a client reference, not the value.
- Development only code (`/design`) sits behind `process.env.NODE_ENV !== 'production'` and loads through `import()` in a client component, so production bundles drop it.

## Agent skills

- [nextjs-app-router-patterns](../../.claude/skills/nextjs-app-router-patterns/): `wshobson/agents`, App Router, server and client components
- [vercel-react-best-practices](../../.claude/skills/vercel-react-best-practices/): React and Next.js performance guidance
- [playwright-best-practices](../../.claude/skills/playwright-best-practices/): `currents-dev/playwright-best-practices-skill`, the `e2e/` suite: locators, waiting, projects, axe checks

_Drafted by /sync from the design system change, worth a quick human pass._
