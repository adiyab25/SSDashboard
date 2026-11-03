# Verify: Design system & UI foundation · spec 0003 · updated 2026-11-03
_Steps derived from spec 0003 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

Local setup: `docker compose -f deploy/compose.dev.yaml up -d`, `pnpm db:migrate`, then `pnpm dev` (web on 3000, api on 3001). If those ports are taken, run the api with `PORT=<api port>` and the web with `API_INTERNAL_URL=http://127.0.0.1:<api port> next dev --port <web port>`, and open the web on `localhost` (Next dev blocks its scripts for `127.0.0.1`).

## UI / manual
- [ ] Open `/` in light, left to right → the shell shows the client name, the sidebar lists Home under General, and the page sits in the single main landmark → AC-3, AC-9
- [ ] Open `/` and `/design` → each page has exactly one `h1` → AC-3
- [ ] Press Tab right after load → "Skip to main content" is focused first; Enter moves focus to the main content → AC-4
- [ ] Keep pressing Tab, then Shift+Tab → every shell control is visited in visual order, the reverse order comes back the same way, and a 2px focus ring shows on each → AC-4
- [ ] Press Ctrl+K (Cmd+K on macOS), type "des", press Enter → you land on `/design` and the palette closes → AC-4, AC-8
- [ ] Open the palette with its button, press Esc → focus returns to the button. Focus "Check again", press Ctrl+K, press Esc → focus returns to "Check again" → AC-4
- [ ] Open the palette while focus is in a text field → it opens; Ctrl+K again closes it → AC-4
- [ ] Open the user menu and press Esc → the menu closes and focus returns to its trigger → AC-4
- [ ] Press Ctrl+B at 1280px wide → the sidebar collapses to an icon rail; reload → still collapsed; the toggle expands it again → AC-4, AC-7
- [ ] At 375px wide → the sidebar is hidden; the menu button opens it as a sheet from the start edge; picking a page closes it → AC-7
- [ ] User menu → Direction → Right to left → the page flips without a reload; the sidebar sits on the right; the chevron in the Theme sub menu is mirrored; at 375px the sheet enters from the right → AC-5, AC-7
- [ ] User menu → Theme → Dark, then reload → no light flash and `html.dark` stays. Clear localStorage `theme` and emulate a dark OS → the first visit is dark → AC-6
- [ ] Emulate a coarse pointer (touch) → the menu button, location switcher, search button, user menu trigger, and sheet items each measure at least 44 by 44 → AC-14
- [ ] Open `/design` in development → every contrast pair shows a ratio that meets its minimum, the button matrix shows default, hover, focus, active, disabled, and loading, the right to left row is mirrored, and the Arabic specimen renders in IBM Plex Sans Arabic → AC-1, AC-2, AC-11, AC-13
- [ ] On `/design`, switch Light and Dark → the live contrast ratios update to the new theme → AC-2, AC-11

## Value sourcing
- [ ] Client name: set `CLIENT_DISPLAY_NAME=Acme Home` and restart the api → the top bar shows "Acme Home". Set it to spaces → "SSDashboard". Stop the api, or answer `/api/config` with 500 → the top bar shows "SSDashboard" and the rest of the shell still works → AC-9
- [ ] Config is fetched once per browser session: navigate between Home and `/design` → the network log shows one `/api/config` request → AC-9
- [ ] Version: set `APP_VERSION=9.9.9` → `GET /api/config` returns `"version": "9.9.9"`; Home shows `0.0.0-dev` in the right order in right to left too → AC-9
- [ ] Location list: seed a warehouse, a showroom, a transit, a virtual, and an archived warehouse → the switcher lists only the active warehouse and showroom, by code, after "All locations" → AC-10
- [ ] Location label: a location with only `name.ar` shows the Arabic name; one with blank names shows its code; `name.en` with spaces is trimmed → AC-10
- [ ] Selected location: pick one, reload → still selected, and the `ss_location` cookie holds its id (`SameSite=Lax`, `Path=/`, one year) → AC-10
- [ ] Stale selection: set `ss_location` to an id that is not listed, or archive the selected location → the switcher shows "All locations", `useCurrentLocation()` is `'all'`, and the cookie is rewritten to `all` → AC-10
- [ ] Status empty: no warehouse or showroom rows → the switcher is disabled and reads "No locations yet" → AC-10
- [ ] Status error: answer `/api/locations` with 500 → the switcher reads "Locations unavailable", its popover shows the error and "Try again", and retry loads the list → AC-10
- [ ] Status loading: delay `/api/locations` → the switcher reads "All locations" and `useCurrentLocation()` is `'all'` until it answers → AC-10
- [ ] Pagination: with more than one page of locations → the web follows `nextCursor` until all are loaded → AC-10
- [ ] Navigation entries: in development the sidebar and palette list Home and Design system; in a production build only Home → AC-8, AC-11
- [ ] Active item: on `/` Home has `aria-current="page"`; on `/design` (and any path below it) Design system has it and Home does not → AC-3
- [ ] Sidebar state: collapse, then check the `sidebar_state=false` cookie; delete it and reload → the sidebar starts expanded → AC-7
- [ ] Shortcut label: on Windows or Linux the palette button shows "Ctrl K"; on macOS it shows "⌘ K" after load → AC-4
- [ ] `<html>` class: localStorage `theme` set to `dark` gives `html.dark` before first paint; `system` follows the OS → AC-6
- [ ] `<html dir>`: localStorage `ss_dir=rtl` in development gives `dir="rtl"` before first paint; in a production build the page is always `dir="ltr"` even with `ss_dir=rtl` → AC-5, AC-11
- [ ] `<html lang>`: always `en` → AC-12
- [ ] Shell text: every shell string comes from `apps/web/src/i18n/messages.en.ts`; `packages/ui` components hold no English text of their own → AC-12
- [ ] User menu identity: shows the avatar "S" and "Staff", Theme, Direction (development only), and a disabled "Sign out" with "Available after sign in" → AC-6, AC-11

## Commands
- [ ] `pnpm lint` → passes, including `check-logical-css.mjs` on `packages/ui/src` and `apps/web/src` → AC-5
- [ ] Add `ml-2` to a class in `apps/web/src` and run `pnpm --filter @ssdashboard/web lint` → fails and names the file and line; remove it → AC-5
- [ ] `pnpm --filter @ssdashboard/config test` → the logical CSS check's own tests pass (planted `ml-2` fixture) → AC-5
- [ ] Add `t('shell.nope')` anywhere in `apps/web/src` and run `pnpm --filter @ssdashboard/web typecheck` → fails; remove it → AC-12
- [ ] `pnpm test` → every unit suite passes, including the axe checks for each `packages/ui` component → AC-2
- [ ] `curl "localhost:3001/api/locations?limit=1"` → one item and a `nextCursor`; following the cursors walks every location once → AC-10
- [ ] `curl -i "localhost:3001/api/locations?cursor=not*a*cursor"` and `?limit=500` → 400 with `"code": "INVALID_QUERY"` → AC-10
- [ ] `pnpm --filter @ssdashboard/api test:e2e` (after `pnpm build`) → `locations.e2e-spec.ts` passes against Postgres → AC-10
- [ ] `pnpm test:e2e` → `shell.spec.ts` passes the axe matrix (light and dark × left to right and right to left × `/` and `/design`), keyboard, right to left, phone, theme, and switcher tests, and `production.spec.ts` passes against `next start` → AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, AC-10, AC-11, AC-13, AC-14
- [ ] `pnpm --filter @ssdashboard/web build`, then search `.next/static` for "Color roles and live contrast" → no match (the gallery is not in production bundles) → AC-11
- [ ] `docker build -f deploy/Dockerfile.web .` → builds, with the shared CSS resolved → AC-5, AC-12

## Acceptance-criteria coverage
- AC-1 `DESIGN.md` contents: `/design` step; read `packages/ui/DESIGN.md` against the AC list
- AC-2 contrast and axe: `/design` contrast steps, `pnpm test`, `pnpm test:e2e` axe matrix
- AC-3 shell and landmarks: first two UI steps, active item step
- AC-4 keyboard: skip link, Tab order, palette, Esc, Ctrl+B, shortcut label steps
- AC-5 right to left and logical CSS: direction switch, `<html dir>`, lint and planted `ml-2` steps, Docker build
- AC-6 theme: theme step, `<html>` class step, user menu identity
- AC-7 sidebar collapse and sheet: Ctrl+B, 375px, sidebar state steps
- AC-8 palette: Ctrl+K and navigation entries steps
- AC-9 client name: client name, config once, version steps
- AC-10 location switcher and endpoint: every location step, curl and api e2e commands
- AC-11 `/design` gating and direction in production: `/design` steps, navigation entries, `<html dir>`, bundle search, `production.spec.ts`
- AC-12 strings: shell text, `<html lang>`, `t('shell.nope')` typecheck, Docker build
- AC-13 fonts: `/design` Arabic specimen step, `production.spec.ts` font host check
- AC-14 touch sizes: coarse pointer step, phone tests in `pnpm test:e2e`
