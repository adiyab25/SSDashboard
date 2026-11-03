<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# apps/web

## Overview

The Next.js App Router back office. Every page renders inside the app shell (`src/shell/`), built from `@ssdashboard/ui` to [`packages/ui/DESIGN.md`](../../packages/ui/DESIGN.md). Decision: [spec 0003](../../docs/specs/0003-design-system-ui-foundation/index.md).

## Key files

| File | Owns |
|---|---|
| `src/app/layout.tsx` | Static root layout: fonts, the development direction script, skip link, `Providers`, `AppShell` |
| `src/app/providers.tsx` | Theme (`next-themes`), direction, current location, tooltips |
| `src/shell/nav.ts` | The typed navigation registry the sidebar and command palette read |
| `src/shell/current-location.tsx` | `useCurrentLocation()` and the `ss_location` cookie |
| `src/i18n/messages.en.ts`, `src/i18n/t.ts` | Every UI string and the typed `t()` |
| `src/design/` | The development only `/design` gallery |

## Commands

```bash
pnpm --filter @ssdashboard/web test        # Vitest + Testing Library (src/**/*.spec.tsx)
pnpm --filter @ssdashboard/web test:e2e    # Playwright: desktop, mobile, and production projects
```

- The production project runs `next start` on the last build (`E2E_PROD_PORT`, default 3100); build first. Point the suite at servers that are already running with `E2E_BASE_URL` and `E2E_PROD_BASE_URL`.
- Open the dev server on `localhost`, not `127.0.0.1`: Next dev blocks its own scripts for other origins, so the page never hydrates.

## Conventions

- No hard coded UI text: add the string to `messages.en.ts` and read it with `t('dotted.key')`; a wrong key fails the type check.
- A page joins the sidebar and palette by adding an entry to `navItems` in `src/shell/nav.ts` (`devOnly` for development only pages).
- Business data loads in client components on relative `/api` paths; browser state (theme, direction, sidebar, location) is read on the client, never with `cookies()` in a layout.
- A server file that needs a value from shell code imports it from a plain module (like `src/shell/direction-config.ts`), never from a `'use client'` file: there it gets a client reference, not the value.
- Development only code (`/design`, the direction switch) sits behind `process.env.NODE_ENV !== 'production'` and loads through `import()` in a client component, so production bundles drop it.

## Agent skills

- [nextjs-app-router-patterns](../../.claude/skills/nextjs-app-router-patterns/): `wshobson/agents`, App Router, server and client components
- [vercel-react-best-practices](../../.claude/skills/vercel-react-best-practices/): React and Next.js performance guidance
- [playwright-best-practices](../../.claude/skills/playwright-best-practices/): `currents-dev/playwright-best-practices-skill`, the `e2e/` suite: locators, waiting, projects, axe checks

_Drafted by /sync from the design system change, worth a quick human pass._
