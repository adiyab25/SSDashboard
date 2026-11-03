# 0003. Build the back office design system on shadcn/ui (Radix, Vega, zinc) in a shared `packages/ui`, with the app shell as its first real screen

**Date**: 2026-11-03
**Status**: In Progress

## Summary

This spec sets the look of the back office and builds its frame (the app shell: sidebar, top bar, location switcher, command palette) that every later screen sits inside. The look is quiet and neutral: zinc grays, black and white actions with no colored accent, 10px corners, IBM Plex Sans in English and Arabic, light and dark modes, compact table rows, and normal sized forms. The components live in a new shared `packages/ui` package built from shadcn/ui, written with start and end (logical) sides so Arabic right to left layout mirrors cleanly. A development only `/design` page shows every token and component, and automated accessibility checks (axe) run on it in light, dark, left to right, and right to left.

## Requirements

**User stories**:
- As a staff member, I want every screen inside one consistent frame with navigation, so I always know where I am and can move fast.
- As a staff member at a warehouse or showroom, I want to pick the location I'm working in once, so later screens can show that place by default.
- As a keyboard or screen reader user, I want every control reachable and announced, with visible focus, so I can work without a mouse.
- As an Arabic speaking user, I want the whole frame mirrored right to left, so it reads naturally.
- As a developer, I want one written design standard and a gallery page, so later features build screens that match without guessing.

**Acceptance criteria**:
- **AC-1**: `packages/ui/DESIGN.md` exists and defines: color roles for light and dark with each pair's measured contrast, the type scale and fonts, spacing, radius, density (table row and form control heights), focus style, elevation, motion, icon rules including which icons mirror in right to left, and component rules for the shell, data tables, forms, and feedback (toast, dialog, empty, loading, error states).
- **AC-2**: Every text color pair defined in the tokens meets 4.5:1 contrast (3:1 for large text), and every UI component boundary and the focus indicator meets 3:1 against adjacent colors, in both light and dark. axe reports zero violations on the shell and on `/design` in all four combinations: light and dark, each in left to right and right to left.
- **AC-3**: Every page renders inside the shell: a sidebar listing the navigation registry entries grouped by module, a top bar with the client name, the location switcher, a command palette button, and the user menu, plus a single `main` landmark holding the page content.
- **AC-4**: Keyboard: a "Skip to main content" link is the first focusable element; Tab moves through every shell control in visual order in both directions; focus is always visible; Ctrl+B (Cmd+B on macOS) toggles the sidebar; Ctrl+K (Cmd+K) opens the command palette; Esc closes any open overlay and returns focus to the control that opened it.
- **AC-5**: With `dir="rtl"`, the sidebar sits on the right, the mobile sheet slides in from the right, directional icons (chevrons, arrows, back) are mirrored, and the layout is the mirror of left to right. No physical side utilities (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `border-l`, `border-r`, `rounded-l`, `rounded-r`, and the like) exist in `packages/ui` or `apps/web` source; the lint step fails if one is added.
- **AC-6**: Theme offers Light, Dark, and System in the user menu; a first visit follows the operating system setting; the choice survives a reload; the page never flashes the wrong theme on load.
- **AC-7**: On screens 768px wide and up, the sidebar collapses to an icon rail and expands again, and that state survives a reload. Below 768px the sidebar is hidden, opens as a sheet from the start edge via a menu button in the top bar, and closes when you pick a page.
- **AC-8**: The command palette lists every navigation registry entry visible in the current environment, filters as you type, and Enter goes to the highlighted page.
- **AC-9**: The top bar shows `clientName` from `GET /api/config`. If that call fails or is still loading, it shows "SSDashboard" and the rest of the shell works normally.
- **AC-10**: The location switcher lists active (not archived) locations of type warehouse or showroom, ordered by code, with "All locations" first, and never lists transit or virtual locations. The choice is stored in a browser cookie and survives a reload. `useCurrentLocation()` returns the selected location id or `'all'`. If the stored id is not in the loaded list, it falls back to `'all'` and rewrites the cookie. With zero such locations the switcher is visible but disabled and reads "No locations yet". While the list is loading, and if loading fails, `useCurrentLocation()` returns `'all'`; on failure the switcher shows an error message with a retry action.
- **AC-11**: In development, `/design` shows every token (color roles with live contrast, type, spacing, radius, density) and every component in `packages/ui` with its states (default, hover, focus, disabled, loading where it applies), plus a direction switch (left to right or right to left) that also appears in the shell's user menu. In a production build, `/design` returns 404, the direction switch is absent, and the page is always `dir="ltr"`.
- **AC-12**: No UI string is hard coded: all shell and `packages/ui` text comes from the English message dictionary through `t()` (or through props, for `packages/ui` components), and a missing or misspelled key fails the type check. The sample content on the development only `/design` page (specimen text, demo labels) is exempt.
- **AC-13**: Text renders in IBM Plex Sans; any element under `lang="ar"` renders in IBM Plex Sans Arabic. Both fonts are self hosted: the browser makes no request to a third party font host at runtime. A `tabular-nums` utility is available for numeric columns.
- **AC-14**: Every interactive target is at least 24 by 24 CSS pixels; on a coarse pointer (touch screens), shell controls (menu button, sidebar items, switcher, palette button, user menu) are at least 44 by 44.

## Decision

**Chosen option**: Option 2: shadcn/ui in a shared `packages/ui`, with the app shell as the tracer bullet

Build the design system as a shared `@ssdashboard/ui` workspace package initialised with shadcn/ui (Radix primitives, Vega style, zinc base, RTL on), tokens in Tailwind v4 CSS variables, documented in `packages/ui/DESIGN.md`, and prove it end to end by building the real app shell in `apps/web` on top of it.

**Implementation skills**: `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `tailwind-4-docs` (`lombiq/tailwind-agent-skills`, `.claude/skills/tailwind-4-docs/`) · `design-md` (`.claude/skills/design-md/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `vercel-react-best-practices` (`.claude/skills/vercel-react-best-practices/`) · `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `turborepo` (`vercel/turborepo`, `.claude/skills/turborepo/`) · `pnpm` (`antfu/skills`, `.claude/skills/pnpm/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Engineer's choices (fixed)

| Dimension | Choice |
|---|---|
| Design source | No external design; direction set in this spec |
| Kit scope built now | App shell. Tables, forms, and feedback are specified in `DESIGN.md` and built by the first feature that needs them (7, 8) |
| Primitives / style | shadcn/ui on Radix UI, Vega style, `init --rtl` |
| Color | Zinc neutral; primary is near black in light mode and near white in dark mode (monochrome, no hue) |
| Radius | `--radius: 0.625rem` (10px) |
| Modes | Light and dark, System by default, via `next-themes` |
| Density | Table rows 36px; form controls at the Vega defaults; no density toggle |
| Icons | Lucide (`lucide-react`) |
| Fonts | IBM Plex Sans + IBM Plex Sans Arabic, self hosted |
| Component home | `packages/ui` (`@ssdashboard/ui`) |
| Gallery | Development only `/design` route in `apps/web` |
| Accessibility checks | axe in Vitest (components) and in Playwright (pages, all four theme × direction combinations) |
| RTL before feature 5 | Development only direction switch (cookie) |
| Navigation | Collapsible sidebar grouped by module; sheet below 768px |
| Top bar | Client name, location switcher, command palette (Ctrl/Cmd+K), user menu placeholder |
| Branding | Client display name from `GET /api/config`; logo and colors wait for feature 46 |
| Nav items | Only built pages, from a typed registry |
| Location switcher | Warehouses + showrooms + "All"; cookie; exposed via hook, filters nothing yet; disabled when empty |
| Strings | English only, every string behind a typed key (feature 5 adds Arabic and the library) |
| Locations endpoint auth | Open until feature 6 adds the session guard |

### Decisions made in this spec (with the runner up)

- **Package layout**: `packages/ui/src/components/ui/*` (shadcn components), `packages/ui/src/lib/utils.ts` (`cn`), `packages/ui/src/hooks/*`, `packages/ui/src/styles/globals.css` (tokens and base layer), its own `components.json`; `apps/web` keeps a `components.json` pointing its `ui` alias at `@ssdashboard/ui`, so `shadcn add` run in either place lands in `packages/ui`. This is the shadcn monorepo layout. Runner up: tokens in `packages/config` (spec 0001 named it for "Tailwind config"), rejected because in Tailwind v4 the config is CSS that belongs beside the components it themes. `apps/web/src/app/globals.css` becomes `@import "@ssdashboard/ui/globals.css";` plus `@source "../../../../packages/ui/src";` (Tailwind v4 does not scan linked workspace packages on its own). Every CSS dependency the stock shadcn CSS imports (`tw-animate-css` and similar) is imported only inside `packages/ui/src/styles/globals.css` and listed in `packages/ui` dependencies; if the Turbopack Tailwind loader cannot resolve them from there under pnpm's strict layout, also list them in `apps/web`. Milestone 1 proves this resolves in `next dev`, `next build`, and the Docker build.
- **Exports**: `packages/ui` is consumed as TypeScript source (no build step), with `exports` entries per path (`"./components/*": "./src/components/ui/*.tsx"`, `"./lib/*": "./src/lib/*.ts"`, `"./hooks/*": "./src/hooks/*.ts"`, `"./globals.css": "./src/styles/globals.css"`), added to `apps/web` as `"@ssdashboard/ui": "workspace:*"`, and `transpilePackages: ['@ssdashboard/ui']` in `next.config.ts`. `components.json` in both packages sets `iconLibrary: "lucide"`, `rsc: true`, and the `ui`, `utils`, `hooks` aliases to `@ssdashboard/ui/...`. If the shadcn CLI misbehaves in this monorepo, timebox it and copy the generated components by hand (the CLI only generates source). Runner up: a compiled package, rejected as a needless build step for a private monorepo package. Named exports only, as everywhere.
- **`DESIGN.md` home**: `packages/ui/DESIGN.md`, next to the tokens it describes, with a pointer line in root and `packages/ui/AGENTS.md`. Runner up: repo root `DESIGN.md`.
- **Fonts**: loaded in `apps/web/src/app/layout.tsx` with `next/font/google` (`IBM_Plex_Sans` with `subsets: ['latin']`; `IBM_Plex_Sans_Arabic` with `subsets: ['arabic', 'latin']` and `preload: false`, so English pages don't download it; weights 400, 500, 600, `display: 'swap'`), which downloads the files at build time and serves them from the app, so nothing is fetched from Google at runtime. They're exposed as `--font-sans` and `--font-arabic`; tokens map `font-sans` to Plex Sans, and `:lang(ar)` switches to Plex Sans Arabic with line height raised one step. Runner up: `next/font/local` with vendored files, the fallback if Docker builds ever run without network.
- **Tokens** (all oklch CSS variables, light in `:root`, dark in `.dark`, Tailwind v4 `@theme inline` mapping, the shadcn convention): the shadcn zinc set for `background`, `foreground`, `card`, `popover`, `primary` (zinc 900 light, zinc 50 dark), `secondary`, `muted`, `accent`, `border`, `input`, `ring`, and `sidebar-*`; plus status pairs the stock set lacks: `success`, `warning`, `info` alongside `destructive`, each with a `-foreground`, each tuned until it passes AC-2. Start from the stock shadcn zinc oklch values, then make these deliberate changes: darken `input` (the border of fields, outline buttons, checkboxes) until it reaches 3:1 against `background` and `card` in both modes, since the stock zinc border fails that; `border` stays light and is used only for decorative separators and card edges, which are exempt from 3:1; `muted-foreground` (also used for placeholder text) must reach 4.5:1 on `background`, `card`, and `muted`; `destructive` must reach 4.5:1 as text on `background` and its `-foreground` 4.5:1 on it as a fill; every `sidebar-*` text pair meets 4.5:1. Disabled controls are exempt from contrast, but are still styled at 3:1 or more so "No locations yet" stays readable. Status hues exist only for meaning (in stock, low, error, info), never for decoration. Runner up: brand hue tokens, out of scope (feature 46).
- **Type scale**: base UI text 14px (`text-sm`) with 20px line height; secondary 12px (`text-xs`); page title 20px semibold; section title 16px semibold. Weights 400, 500, 600 only.
- **Density**: table row 36px, table header 40px, form controls the Vega default height (36px), shell top bar 56px, sidebar item 32px on fine pointers.
- **Touch sizing** (AC-14): `globals.css` defines `@custom-variant coarse (@media (pointer: coarse));`. Under `coarse:`, the menu button, sidebar and icon rail items, sheet items, switcher trigger, palette button, user menu trigger and its items, and command items are at least 44px tall (icon only ones 44 by 44). Everywhere, the 24 by 24 floor also covers dialog and sheet close buttons (pad the stock close icon), tooltip triggers, and `Kbd` when it is clickable.
- **Focus**: `focus-visible` only, 2px `ring` outline with 2px offset, the same in every component; the monochrome ring is near black on light and near white on dark, which passes 3:1.
- **Motion**: shadcn defaults (150 to 200ms), all disabled under `prefers-reduced-motion: reduce`.
- **Icon mirroring**: directional Lucide icons get `rtl:-scale-x-100` (Tailwind's `rtl:` variant); `DESIGN.md` lists which icons count as directional. Non directional icons (search, user, box) never mirror. Runner up: a `DirectionalIcon` wrapper, rejected as one more component to learn for a one class rule.
- **Logical CSS enforcement** (AC-5): a small Node script `packages/config/scripts/check-logical-css.mjs` (add `scripts` to `packages/config`'s `files`) that scans `.ts`, `.tsx`, and `.css` under `packages/ui/src` and `apps/web/src` (skipping `node_modules`, `.next`, and its own fixtures) for physical side utilities and properties: CSS `margin-left|right`, `padding-left|right`, `left:`, `right:`, `border-left|right`, `text-align: left|right`; Tailwind `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `border-l`, `border-r`, `rounded-l`, `rounded-r`, `rounded-tl|tr|bl|br`, `float-left|right`, `slide-in-from-left|right`, `slide-out-to-left|right`, `origin-left|right`, and `data-[side=left|right]` (with optional `-` prefix and variant prefixes). It allowlists `rtl:-scale-x-100`, `ltr:` and `rtl:` scoped overrides, and lines marked `// logical-css-ignore: <reason>`. `space-x-*` and `divide-x-*` are allowed (Tailwind v4 makes them direction aware). Each package's `lint` script becomes `eslint . && node ../../packages/config/scripts/check-logical-css.mjs <src dir>`. Expect to patch leftovers that `shadcn init --rtl` does not convert. Runner up: an ESLint plugin for Tailwind classes, rejected because Tailwind v4 support in those plugins is uneven.
- **`/design` gating and contrast**: the page calls `notFound()` when `process.env.NODE_ENV === 'production'`, and the production check asserts a real 404 status (not a 200 page). Its gallery modules load through `import()` behind the same check, so production bundles don't carry them, and it is never linked or prefetched in production (it is `devOnly` in the registry). Live contrast reads each resolved color by painting it onto a 1 by 1 canvas and reading the sRGB pixel back (this handles `oklch` values), then computes the WCAG 2 ratio. Pinned states are forced with `data-state-preview="hover|focus|active"` attributes that the component styles honour only inside the gallery wrapper.
- **Theme**: `next-themes` (0.4.6 or later, checked against React 19 and Next 16 for script warnings) `ThemeProvider`, in a client `Providers` component in `apps/web/src/app/providers.tsx` (with the `DirectionProvider` and `CurrentLocationProvider`), with `attribute="class"`, `defaultTheme="system"`, `enableSystem`, `disableTransitionOnChange`; `<html suppressHydrationWarning>`.
- **Root layout stays static.** `cacheComponents` is on in `next.config.ts`, so the root layout never calls `cookies()` or `headers()` (that would force a Suspense boundary around the whole app and cannot set `<html>` attributes). It renders `<html lang="en" dir="ltr" suppressHydrationWarning>`, and all browser state is read on the client. Read `node_modules/next/dist/docs/` first, as `apps/web/AGENTS.md` asks.
- **Direction (development only)**: stored in localStorage `ss_dir` (`ltr` or `rtl`). In development only (`process.env.NODE_ENV !== 'production'`, inlined at build), the layout renders a small inline `<script>` in `<head>` that sets `document.documentElement.dir` from `ss_dir` before first paint, and a client `DirectionBridge` passes the same value to Radix's `DirectionProvider`, which wraps the whole app (including every portal: dropdowns, popovers, tooltips, sheet). The switch writes localStorage, updates `<html dir>`, and updates the provider state, with no reload. Radix reads only the provider, never `<html dir>`, so both must change together. Production builds contain neither the script nor the switch. Feature 5 replaces this whole mechanism with the language switch.
- **Strings**: `apps/web/src/i18n/messages.en.ts` exports a nested `as const` object; `apps/web/src/i18n/t.ts` exports `t(key: MessageKey)` where `MessageKey` is the union of dotted paths, so a wrong key fails `tsc` (AC-12). `packages/ui` components hold no text of their own; labels arrive as props (including the sr only labels, such as "Toggle sidebar", passed by the shell). No interpolation or plurals yet (no shell string needs them); feature 5 adds them. Key namespaces: `shell.skipLink`, `shell.nav.groups.*`, `shell.nav.items.*`, `shell.topbar.*` (menu button, palette button), `shell.palette.*` (placeholder, no results, group headings), `shell.user.*` (menu name, placeholder name, theme, direction, sign out, sign out hint), `shell.theme.*` (light, dark, system), `shell.direction.*`, `shell.locations.*` (all, none yet, loading, error, retry, search, label), `shell.sidebar.toggle`, `home.*` (including the `ApiStatus` texts). Runner up: `next-intl`, deferred to feature 5's decision.
- **Home page**: Home keeps `ApiStatus` inside the shell with a page `<h1>` (from `t('home.title')`); its hard coded texts move to `messages.en.ts`, and the existing `page.spec.tsx`, `layout.spec.tsx`, `api-status.spec.tsx`, and `e2e/home.spec.ts` are updated to match. Every page renders exactly one `<h1>`.
- **Navigation registry**: `apps/web/src/shell/nav.ts` exports `navItems: readonly NavItem[]` with `{ id, labelKey: MessageKey, href, icon: LucideIcon, group: NavGroup, devOnly?: true }`; `NavGroup` is a union (`'general'` now; `'inventory'`, `'purchasing'` and others are added by the features that ship them). Today it holds Home (`/`) and Design (`/design`, `devOnly`), both in group `general` (heading `shell.nav.groups.general`, "General"). Sidebar and palette both read it, filtered by environment; a group with no visible items is not rendered. The active item gets `aria-current="page"`: exact match for `/`, prefix match (`pathname === href || pathname.startsWith(href + '/')`) for others. Features 13 and 46 later filter the same list by role and module toggle.
- **Sidebar state**: the shadcn `Sidebar` keeps its own cookie (`sidebar_state`, its default 7 day expiry), read on the client only (see *Root layout stays static*), so a collapsed sidebar may show expanded for one frame on reload; accepted. The mobile breakpoint is 768px. To avoid a desktop sidebar flashing on phones before `useIsMobile` settles, the desktop sidebar and the mobile menu button are shown and hidden with CSS (`md:` classes), and `useIsMobile` only decides whether the sheet is used. The sheet closes on navigation: `setOpenMobile(false)` in an effect on `usePathname()`.
- **Skip link and landmarks**: the first element in `body` is a link to `#main-content` (text `t('shell.skipLink')`), visually hidden until focused, positioned with logical utilities. `<main id="main-content" tabIndex={-1}>` holds the page. The sidebar is inside `<nav aria-label>`, the top bar is `<header>`. Tab order follows DOM order, so it mirrors automatically in right to left.
- **Command palette**: shadcn `CommandDialog` (cmdk) opened by Ctrl+K or Cmd+K on every platform (`preventDefault` so the browser's own shortcut does not fire). It also opens while focus is in a text field, and the shortcut closes it if it is already open. A visible top bar button shows the shortcut in a `Kbd`; the server renders "Ctrl K", and after mount it switches to "⌘ K" on Apple platforms, which avoids a hydration mismatch. On Esc, focus returns to the element that was focused before it opened (the button when opened by click, the previously focused element when opened by shortcut). It lists navigation entries now; later features register more groups.
- **User menu placeholder**: a trigger with accessible name `t('shell.user.menu')` ("User menu") showing an avatar with the initial "S" and the label "Staff", a Theme sub menu (Light, Dark, System), the Direction sub menu in development only, and a disabled "Sign out" item with the hint "Available after sign in". Feature 6 replaces the identity part.
- **Location switcher**: a shadcn `Popover` + `Command` combobox (searchable), state in `apps/web/src/shell/current-location.tsx` (a React context provider plus `useCurrentLocation(): string | 'all'` and `setCurrentLocation()`); The context value is `{ current: string | 'all', locations, status: 'loading' | 'ready' | 'empty' | 'error', retry(), setCurrentLocation(id | 'all') }`. Cookie `ss_location`, value a location uuid or `all`, `SameSite=Lax`, `Path=/`, `Max-Age=31536000`, `Secure` when the page is served over https, not `HttpOnly`; read from `document.cookie` after mount. `current` is `'all'` until the list loads, then the stored id if it is in the list, else `'all'` (and the cookie is rewritten). The display name is `name.en` trimmed, else `name.ar` trimmed, else `code`. It follows `nextCursor` until all pages are loaded, capped at 50 pages (beyond that it keeps what it has and logs a console warning).
- **Data loading**: the client name and locations load in client components on relative `/api` paths with `fetch` plus the Zod contract's `.parse`, the same pattern as `ApiStatus` today. The OpenAPI document and generated client are not built by this feature; the first feature that needs them adds them and migrates these two calls. `/api/config` is fetched once per browser session (a module level cached promise, `cache: 'no-store'` on the request), so remounting providers never refetches.
- **API wiring**: `apps/api/src/platform/config.controller.ts` (`GET /api/config`, injects the validated env) registered in `PlatformModule`; `apps/api/src/inventory/locations/locations.controller.ts` and `locations.service.ts` registered in `InventoryModule` (the module that owns `locations`), with `module-boundary.spec.ts` updated if it lists allowed files. Queries are validated by a small `ZodQueryPipe` in `apps/api/src/platform/` that throws `BadRequestException({ code: 'INVALID_QUERY', issues })`. `limit` is `z.coerce.number().int().min(1).max(200).default(200)`; the cursor is the last row's `code`, base64url encoded, and a cursor that does not decode is 400. Ordering and the keyset comparison both use `code COLLATE "C"`, so pages never skip or repeat rows. The `name` contract reuses the shared localized text Zod schema if `packages/contracts` has one (else adds `LocalizedText` there), matching spec 0002's `{ en, ar }` shape.
- **Accessibility test tooling**: `axe-core` run in Vitest through a small helper `expectNoAxeViolations(container)` in `packages/ui/src/test/axe.ts`. jsdom has no layout or color, so this layer checks roles, names, and structure only; contrast (AC-2) and target size (AC-14) are checked only in Playwright. Overlays are checked on `document.body`, since Radix portals render outside the container. `packages/ui` gets its own `vitest.config.ts` (jsdom, `@testing-library/jest-dom`, polyfills for `ResizeObserver`, `matchMedia`, `scrollIntoView`, and pointer capture, which Radix and cmdk need), and `turbo.json` gains a `test` task. `@axe-core/playwright` in `apps/web/e2e` runs with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, on the desktop project only, over the shell and `/design` in the four theme × direction combinations (theme and `ss_dir` set through `addInitScript` writing localStorage before load). Keyboard flows (AC-4) are Playwright tests on desktop; sheet and touch tests use the mobile project with `hasTouch: true` and `isMobile: true`; sidebar collapse tests run on desktop only. The happy path uses database seeded locations; the failure cases stub the api with `page.route`. Production checks (AC-11, AC-13) run in a separate Playwright project whose web server runs `next build && next start` on another port. Runner up: `vitest-axe`, rejected to avoid a thin wrapper dependency with uncertain upkeep.

### Data model sketch

No new tables, columns, or migrations. This feature reads `locations` as defined in spec 0002 (`id`, `code`, `name jsonb {en, ar}`, `type`, `archived_at`). Browser state only:

| Store | Key | Value | Owner |
|---|---|---|---|
| Cookie (read on the client) | `sidebar_state` | `true` or `false` | shadcn Sidebar |
| Cookie (read on the client) | `ss_location` | location uuid or `all` | location switcher |
| localStorage (development only) | `ss_dir` | `ltr` or `rtl` | direction switch, removed by feature 5 |
| localStorage | `theme` | `light`, `dark`, or `system` | next-themes |

**State transitions**: none.

### API surface

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/config` (platform module) | GET | none | `clientName: string`, `version: string` | public (needed before sign in) | none expected; a 5xx makes the web use its fallback |
| `/api/locations` (inventory module) | GET | `cursor?: string`, `limit?: int` (1 to 200, default 200) | `items: { id: uuid, code: string, name: { en?: string, ar?: string }, type: 'warehouse' \| 'showroom' }[]`, `nextCursor: string \| null` | open until feature 6 (see Security model) | 400 invalid cursor or limit (stable code `INVALID_QUERY`) |

Both shapes are Zod schemas in `packages/contracts` (`ConfigResponse`, `LocationListQuery`, `LocationListResponse`), used by the api for validation and by the web to parse responses (no OpenAPI or generated client yet, see *Data loading*). `GET /api/locations` filters `type IN ('warehouse','showroom') AND archived_at IS NULL`, orders by `code`, and uses a keyset cursor on `code` (unique). Feature 10 extends this module with location management; this endpoint stays a read.

### Value sourcing

| Action | Value produced / displayed | Source |
|---|---|---|
| Top bar | client name | `GET /api/config` `clientName` ← env `CLIENT_DISPLAY_NAME` (default `SSDashboard`); fallback literal "SSDashboard" in the web when the call fails |
| `GET /api/config` | `version` | existing env `APP_VERSION` |
| Location switcher | list of locations | `GET /api/locations` ← `locations` table (spec 0002), filtered by `type` and `archived_at` |
| Location switcher | each location's label | `name.en` trimmed → `name.ar` trimmed → `code` (English UI until feature 5 picks by locale) |
| Location switcher | selected location | cookie `ss_location`, checked against the loaded list; while loading, on error, missing, or unknown → `'all'` |
| Location switcher | status (loading, ready, empty, error) | the fetch state in `CurrentLocationProvider`; empty = zero items after all pages load |
| `useCurrentLocation()` | current value | the context state above |
| Sidebar, command palette | entries, labels, icons, links | `navItems` registry; labels through `t(labelKey)`; filtered by `devOnly` against `NODE_ENV` |
| Sidebar | expanded or collapsed | cookie `sidebar_state` read on the client; default expanded |
| Sidebar, palette | active item | `usePathname()` with the match rule in *Navigation registry* |
| Palette button | shortcut label | "Ctrl K" on the server; "⌘ K" after mount on Apple platforms (`navigator.userAgent`) |
| `<html>` | `class` (theme) | next-themes from localStorage `theme`; default from `prefers-color-scheme` |
| `<html>` | `dir` | `ltr` in the markup; development only: the inline head script sets it from localStorage `ss_dir` (default `ltr`); production: always `ltr` (until feature 5) |
| `<html>` | `lang` | `en` (until feature 5) |
| All shell text | strings | `messages.en.ts` via `t()` |
| `/design` | contrast ratio per color pair | computed live in the browser from the resolved CSS variables |
| User menu | name and initial | fixed message keys `shell.user.placeholderName` ("Staff") until feature 6 |

### Key invariants

- `packages/ui` never imports from `apps/*`, `@ssdashboard/contracts`, or Next.js (`next/*`); it is plain React plus Radix, Tailwind, Lucide, cmdk, and `next-themes`, so a future storefront or POS app can use it.
- Tokens are the only source of color, radius, and font: no raw hex, rgb, or Tailwind palette classes (`bg-zinc-200`) in components or pages; use the role tokens (`bg-muted`, `text-foreground`).
- No physical left or right styling anywhere in web or ui source (enforced by the check script).
- No hard coded UI text in `apps/web` (through `t()`) or in `packages/ui` (through props).
- Shell server code reads no cookies, headers, or business data (the root layout stays static under `cacheComponents`); browser state is read on the client.
- The direction switch and `/design` never exist in a production build.

### Security model

- `GET /api/config` is public by design (the shell and the future sign in page need it) and returns only the display name and version, nothing secret.
- `GET /api/locations` returns only `id`, `code`, `name`, and `type` (no stock, cost, or settings). It is reachable without sign in until feature 6, which adds the session guard to every `/api` route except `/api/config`, `/api/health`, and `/api/auth/*`. This endpoint is listed in Follow-up so feature 6 covers it. Roles (feature 13) may later restrict which locations a user sees; the switcher then shows only what the endpoint returns.
- Both are cheap indexed reads. Rate limiting for public endpoints is owed to feature 6 (with the auth routes) or feature 16 (Caddy); until then exposure is limited to each client's own install.
- Cookies hold no secrets; `ss_location` is a preference, and the api never trusts it (it is not sent to the api in this feature).
- No personal data, payments, or regulated data in scope.

### Configuration required

- `CLIENT_DISPLAY_NAME`: optional, the install's name shown in the shell. In `apps/api/src/config/env.ts`: trimmed, an empty value treated as unset, default `SSDashboard`, at most 80 characters. Also add it to `.env.example` (commented, with the default), to `turbo.json` `dev.passThroughEnv`, and only to the `api` service's `environment` in `deploy/compose.yaml` (next to `PUBLIC_URL`), not to the shared `x-app-env` block, so `migrate` and `worker` never receive it.

### Critical test scenarios

- Happy path: open `/` in light, left to right; the shell shows the client name from config, the sidebar with Home, the switcher listing seeded warehouses and showrooms; choose one, reload, and it is still selected. Verifies **AC-3**, **AC-9**, **AC-10**.
- Accessibility matrix: Playwright axe on `/` and `/design` in light and dark × left to right and right to left, zero violations. Verifies **AC-2**, **AC-5**, **AC-11**.
- Keyboard: Tab from page load hits the skip link first, then every shell control in order; Ctrl+K opens the palette, typing "des" plus Enter goes to `/design`; Esc closes it and focus returns to the palette button; Ctrl+B collapses the sidebar. Verifies **AC-4**, **AC-8**, **AC-7**.
- Right to left: with localStorage `ss_dir` set to `rtl`, the sidebar's bounding box is at the right edge, a chevron icon's computed transform is mirrored, and at 375px wide the sheet enters from the right. Verifies **AC-5**, **AC-7**.
- Failure case: the config endpoint returns 500, so the shell shows "SSDashboard"; the locations endpoint returns 500, so the switcher shows the error and retry, and `useCurrentLocation()` returns `'all'`; the cookie holds an archived location's id, so the switcher falls back to All and rewrites the cookie. Verifies **AC-9**, **AC-10**.
- Empty install: no warehouse or showroom rows, so the switcher is disabled and reads "No locations yet". Verifies **AC-10**.
- Theme: set Dark, reload, no light flash (screenshot at first paint) and `html.dark` present. Verifies **AC-6**.
- Production build: `/design` returns 404, the user menu has no Direction item, `<html dir="ltr">`; the network log shows no request to a font host. Verifies **AC-11**, **AC-13**.
- Guardrails: the logical CSS check fails on a planted `ml-2`; `tsc` fails on `t('shell.nope')`. Verifies **AC-5**, **AC-12**.
- Touch: at a coarse pointer emulation, shell controls measure at least 44 by 44. Verifies **AC-14**.
- Auth/permission: none yet (no accounts exist); feature 6's tests assert `/api/locations` returns 401 without a session.

## Build plan

Tracer Bullet: the first milestone pushes one thin thread through every layer (env → api → Zod contract → web fetch and parse → shared ui package → web shell). Each later milestone thickens one segment and stays shippable.

1. **Thin thread through every layer**
   1. Create `packages/ui` with `shadcn init` (Radix base, Vega style, zinc, `--rtl`) in the monorepo layout; add `exports`, the `workspace:*` dependency, `transpilePackages`, the `@source` scan, its Vitest config, a `test` task in `turbo.json`, and a nested `packages/ui/AGENTS.md`; prove CSS imports resolve in `next dev`, `next build`, and the Docker web build. Satisfies **AC-5**, **AC-12**.
   2. Add `CLIENT_DISPLAY_NAME` to `env.ts`, `.env.example`, `turbo.json`, and the `api` service in Compose; add `ConfigResponse`, `config.controller.ts`, and `GET /api/config` in the platform module. Satisfies **AC-9**.
   3. Keep the root layout static; add a minimal shell header to Home that shows `clientName` (fetched and parsed, with fallback) and one `Button` from `@ssdashboard/ui`, keeping `ApiStatus`; update the existing web tests; one Vitest axe test and one Playwright test pass in CI. Satisfies **AC-9**, **AC-2**.
2. **Foundations**
   1. Final light and dark tokens including the `success`, `warning`, and `info` pairs, radius, density, focus, motion; fonts through `next/font` with the `:lang(ar)` switch; `tabular-nums`. Satisfies **AC-2**, **AC-13**.
   2. `Providers` with `next-themes`; the development only `ss_dir` head script, `DirectionBridge`, and `DirectionProvider`; `messages.en.ts` and typed `t()`, with the `ApiStatus` strings moved in. Satisfies **AC-6**, **AC-5**, **AC-11**, **AC-12**.
   3. `check-logical-css.mjs` wired into `lint` for `packages/ui` and `apps/web`. Satisfies **AC-5**.
3. **App shell**
   1. Add the shadcn components the shell needs to `packages/ui` (sidebar, sheet, button, dropdown menu, command, dialog, popover, tooltip, avatar, separator, skeleton, kbd), each with a Vitest axe test. Satisfies **AC-2**, **AC-14**.
   2. Shell layout in `apps/web/src/shell/`: nav registry, sidebar with icon collapse and cookie, mobile sheet, top bar, skip link, landmarks, user menu with Theme (and Direction in development), command palette with Ctrl/Cmd+K, coarse pointer sizing, directional icon mirroring. Satisfies **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-7**, **AC-8**, **AC-14**.
4. **Location switcher** (independent of milestones 3 and 5; it never blocks them)
   1. `LocationListQuery` and `LocationListResponse` contracts, `ZodQueryPipe`, and `GET /api/locations` in `inventory/locations/` (keyset pagination on `code COLLATE "C"`, filtered by type and `archived_at`), with an e2e test on seeded rows including a `limit=1` pagination walk and a bad cursor 400. Satisfies **AC-10**.
   2. `CurrentLocationProvider`, `useCurrentLocation()`, the `ss_location` cookie, and the switcher combobox with loading, empty, error and retry, and stale id fallback states. Satisfies **AC-10**.
5. **Gallery, standard, and checks**
   1. Development only `/design` page following the shadcn design system page outline, limited to the foundations and the components in `packages/ui`, with live contrast pairs, pinned states, a right to left row, and an Arabic type specimen under `lang="ar"`; 404 in production. Satisfies **AC-11**, **AC-2**, **AC-13**.
   2. Write `packages/ui/DESIGN.md` from the final tokens (with measured contrast), including the table, form, and feedback rules features 7 and 8 will build to. Satisfies **AC-1**.
   3. Playwright suite: axe matrix (four combinations × two pages), keyboard flows, right to left geometry, theme no flash, production build checks, touch sizes. Satisfies **AC-2**, **AC-4**, **AC-5**, **AC-6**, **AC-7**, **AC-8**, **AC-11**, **AC-13**, **AC-14**.

## Consequences

**Positive**:
- Every later screen starts inside a finished, accessible, mirrored frame, and builds to one written standard instead of guessing.
- A shared `packages/ui` is ready for a storefront or POS app without moving files later.
- Logical CSS and typed string keys are enforced by tooling from the first commit, so right to left and translation debt can't build up quietly.
- The location context exists before any stock screen, so features 7 to 12 filter by it without redesigning the shell.

**Negative / tradeoffs**:
- A shared package before a second consumer exists: extra `exports`, `@source`, and `transpilePackages` wiring, and `shadcn add` must be run from the right `components.json`.
- A monochrome primary makes primary actions stand out less than a colored accent would; the hierarchy has to come from weight, fill versus outline, and placement. Status colors carry all hue.
- English only text means right to left testing here sees English words in a mirrored layout; Arabic length and line height issues surface only in feature 5 (the `/design` Arabic specimen catches font issues, not layout overflow).
- `GET /api/locations` and `GET /api/config` ship unauthenticated and without rate limiting until feature 6 or 16.
- With the root layout static, browser state is read after mount: a collapsed sidebar can show expanded for one frame on reload, and the location switcher shows "All" briefly while loading.
- Two calls use `fetch` plus `.parse` instead of a generated client; the feature that adds OpenAPI must migrate them.
- Fonts come from Google at build time; an offline Docker build fails until it switches to `next/font/local`.
- The development direction switch is throwaway code that feature 5 must remove.

**Neutral**:
- `apps/web/src/app/globals.css` shrinks to an import of the package's tokens.
- Spec 0001's line that `packages/config` holds the Tailwind config is superseded in practice: tokens live in `packages/ui`; `packages/config` keeps TypeScript, ESLint, and now the logical CSS check script.
- New dependencies: `next-themes`, `lucide-react`, `cmdk` and the Radix packages (through shadcn), `axe-core`, `@axe-core/playwright`.

## Follow-up

- [ ] Feature 6: put `GET /api/locations` behind the session guard (all `/api` routes except `/api/config`, `/api/health`, `/api/auth/*`), add rate limiting for the public routes, and replace the user menu placeholder with the signed in staff member.
- [ ] Feature 5: replace the development `ss_dir` cookie and `DirectionProvider` wiring with the language switch, move `messages.en.ts` keys into the chosen library, add Arabic messages, pick location names by locale, and check Arabic text length and line height across the shell.
- [ ] Features 7 and 8: build the data table, form fields, and feedback components to the rules in `packages/ui/DESIGN.md` and add them to `/design`.
- [ ] Feature 10: location management extends the inventory module's locations surface; keep `GET /api/locations` filtering compatible with the switcher.
- [ ] Feature 13 and 46: filter `navItems` by role and module toggle; feature 46 adds per client logo and accent overrides on top of these tokens.
- [ ] `/sync`: add `packages/ui/AGENTS.md` and `DESIGN.md` pointers to root `AGENTS.md` `## Context files`, note that tokens moved from `packages/config` to `packages/ui`, and add the shadcn and Tailwind 4 conventions (Radix `asChild`, role tokens only, logical utilities) to root `## Rules`.
