# Verify: Design system & UI foundation · spec 0003 · updated 2026-11-03
_Steps derived from spec 0003 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

Local setup: `docker compose -f deploy/compose.dev.yaml up -d`, `pnpm db:migrate`, then `pnpm dev` (web on 3000, api on 3001). If those ports are taken, run the api with `PORT=<api port>` and the web with `API_INTERNAL_URL=http://127.0.0.1:<api port> next dev --port <web port>`, and open the web on `localhost` (Next dev blocks its scripts for `127.0.0.1`).

## UI / manual
- [x] Open `/` in light, left to right → the shell shows the client name, the sidebar lists Home under General, and the page sits in the single main landmark → AC-3, AC-9
- [x] Open `/` and `/design` → each page has exactly one `h1` → AC-3
- [x] Press Tab right after load → "Skip to main content" is focused first; Enter moves focus to the main content → AC-4
- [x] Keep pressing Tab, then Shift+Tab → every shell control is visited in visual order, the reverse order comes back the same way, and a 2px focus ring shows on each → AC-4
- [x] Press Ctrl+K (Cmd+K on macOS), type "des", press Enter → you land on `/design` and the palette closes → AC-4, AC-8
- [x] Open the palette with its button, press Esc → focus returns to the button. Focus "Check again", press Ctrl+K, press Esc → focus returns to "Check again" → AC-4
- [x] Open the palette while focus is in a text field → it opens; Ctrl+K again closes it → AC-4
- [x] Open the user menu and press Esc → the menu closes and focus returns to its trigger → AC-4
- [x] Press Ctrl+B at 1280px wide → the sidebar collapses to an icon rail; reload → still collapsed; the toggle expands it again → AC-4, AC-7
- [x] At 375px wide → the sidebar is hidden; the menu button opens it as a sheet from the start edge; picking a page closes it → AC-7
- [x] User menu → Direction → Right to left → the page flips without a reload; the sidebar sits on the right; the chevron in the Theme sub menu is mirrored; at 375px the sheet enters from the right → AC-5, AC-7
- [x] User menu → Theme → Dark, then reload → no light flash and `html.dark` stays. Clear localStorage `theme` and emulate a dark OS → the first visit is dark → AC-6
- [x] Emulate a coarse pointer (touch) → the menu button, location switcher, search button, user menu trigger, and sheet items each measure at least 44 by 44 → AC-14
- [x] Open `/design` in development → every contrast pair shows a ratio that meets its minimum, the button matrix shows default, hover, focus, active, disabled, and loading, the right to left row is mirrored, and the Arabic specimen renders in IBM Plex Sans Arabic → AC-1, AC-2, AC-11, AC-13
- [x] On `/design`, switch Light and Dark → the live contrast ratios update to the new theme → AC-2, AC-11

## Value sourcing
- [x] Client name: set `CLIENT_DISPLAY_NAME=Acme Home` and restart the api → the top bar shows "Acme Home". Set it to spaces → "SSDashboard". Stop the api, or answer `/api/config` with 500 → the top bar shows "SSDashboard" and the rest of the shell still works → AC-9
- [x] Config is fetched once per browser session: navigate between Home and `/design` → the network log shows one `/api/config` request → AC-9
- [x] Version: set `APP_VERSION=9.9.9` → `GET /api/config` returns `"version": "9.9.9"`; Home shows `0.0.0-dev` in the right order in right to left too → AC-9
- [x] Location list: seed a warehouse, a showroom, a transit, a virtual, and an archived warehouse → the switcher lists only the active warehouse and showroom, by code, after "All locations" → AC-10
- [x] Location label: a location with only `name.ar` shows the Arabic name; one with blank names shows its code; `name.en` with spaces is trimmed → AC-10
- [x] Selected location: pick one, reload → still selected, and the `ss_location` cookie holds its id (`SameSite=Lax`, `Path=/`, one year) → AC-10
- [x] Stale selection: set `ss_location` to an id that is not listed, or archive the selected location → the switcher shows "All locations", `useCurrentLocation()` is `'all'`, and the cookie is rewritten to `all` → AC-10
- [x] Status empty: no warehouse or showroom rows → the switcher is disabled and reads "No locations yet" → AC-10
- [x] Status error: answer `/api/locations` with 500 → the switcher reads "Locations unavailable", its popover shows the error and "Try again", and retry loads the list → AC-10
- [x] Status loading: delay `/api/locations` → the switcher reads "All locations" and `useCurrentLocation()` is `'all'` until it answers → AC-10
- [x] Pagination: with more than one page of locations → the web follows `nextCursor` until all are loaded → AC-10
- [x] Navigation entries: in development the sidebar and palette list Home and Design system; in a production build only Home → AC-8, AC-11
- [x] Active item: on `/` Home has `aria-current="page"`; on `/design` (and any path below it) Design system has it and Home does not → AC-3
- [x] Sidebar state: collapse, then check the `sidebar_state=false` cookie; delete it and reload → the sidebar starts expanded → AC-7
- [x] Shortcut label: on Windows or Linux the palette button shows "Ctrl K"; on macOS it shows "⌘ K" after load → AC-4
- [x] `<html>` class: localStorage `theme` set to `dark` gives `html.dark` before first paint; `system` follows the OS → AC-6
- [x] `<html dir>`: localStorage `ss_dir=rtl` in development gives `dir="rtl"` before first paint; in a production build the page is always `dir="ltr"` even with `ss_dir=rtl` → AC-5, AC-11
- [x] `<html lang>`: always `en` → AC-12
- [x] Shell text: every shell string comes from `apps/web/src/i18n/messages.en.ts`; `packages/ui` components hold no English text of their own → AC-12
- [x] User menu identity: shows the avatar "S" and "Staff", Theme, Direction (development only), and a disabled "Sign out" with "Available after sign in" → AC-6, AC-11

## Commands
- [x] `pnpm lint` → passes, including `check-logical-css.mjs` on `packages/ui/src` and `apps/web/src` → AC-5
- [x] Add `ml-2` to a class in `apps/web/src` and run `pnpm --filter @ssdashboard/web lint` → fails and names the file and line; remove it → AC-5
- [x] `pnpm --filter @ssdashboard/config test` → the logical CSS check's own tests pass (planted `ml-2` fixture) → AC-5
- [x] Add `t('shell.nope')` anywhere in `apps/web/src` and run `pnpm --filter @ssdashboard/web typecheck` → fails; remove it → AC-12
- [x] `pnpm test` → every unit suite passes, including the axe checks for each `packages/ui` component → AC-2
- [x] `curl "localhost:3001/api/locations?limit=1"` → one item and a `nextCursor`; following the cursors walks every location once → AC-10
- [x] `curl -i "localhost:3001/api/locations?cursor=not*a*cursor"` and `?limit=500` → 400 with `"code": "INVALID_QUERY"` → AC-10
- [x] `pnpm --filter @ssdashboard/api test:e2e` (after `pnpm build`) → `locations.e2e-spec.ts` passes against Postgres → AC-10
- [x] `pnpm test:e2e` → `shell.spec.ts` passes the axe matrix (light and dark × left to right and right to left × `/` and `/design`), keyboard, right to left, phone, theme, and switcher tests, and `production.spec.ts` passes against `next start` → AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, AC-10, AC-11, AC-13, AC-14
- [x] `pnpm --filter @ssdashboard/web build`, then search `.next/static` for "Color roles and live contrast" → no match (the gallery is not in production bundles) → AC-11
- [x] `docker build -f deploy/Dockerfile.web .` → builds, with the shared CSS resolved → AC-5, AC-12

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

## Amendment 2026-11-05: checks

_Added for the amendment (AC-15 to AC-23). Run after the build plan's milestones; the checks above stay and must still pass with the chosen direction._

Local setup is the same as above. For the phone checks use the Playwright mobile project or the browser's device toolbar at 360 by 800 with touch.

### UI / manual

- [ ] Open `/design` in light and dark → the color list shows the chosen direction's values, and every pair (the four meaning colors on the page, the card, and their chip surface, `brand-foreground` on `brand`, the dashed provisional border) shows a ratio at or above its minimum → AC-15
- [ ] Open `/design` → a sample order row table shows one chip per state, each with an icon and a word; with a grayscale filter on, every status is still readable → AC-16
- [ ] On the sample row table, a row with more than three states shows two chips and a "+N" chip that opens the rest → AC-16
- [ ] Inspect the sample provisional total with a screen reader (or its accessible name) → it says "provisional"; visually it starts with `≈` and has a dashed boundary; a total mixing both shows the confirmed and provisional parts apart → AC-17
- [ ] In `dir="rtl"`, the `≈` still sits at the start of the number, before it → AC-17
- [ ] Open the sample dashboard → the freshness strip names the last confirmed operating day and says today is provisional → AC-17, AC-20
- [ ] On `/design` "Frames" → `AppShell`, `PortalFrame`, and `PartnerFrame` each render exactly one `h1` and one `main`; the portal has no sidebar, no palette, no staff navigation; the partner frame has no location switcher and no palette → AC-18
- [ ] Set the sample portal accent to `#0A7C39` → accepted with a white foreground at 5.31:1; set it to a pale yellow → refused with a suggestion; the logo has an `alt` → AC-19
- [ ] With a green accent, view a confirmed chip and a failed chip in the portal sample → the chips keep the system colors; the accent appears only on the logo tile, the top rule, and the main button; the focus ring is the system ring → AC-19
- [ ] At 360 by 800 with touch, open the sample dashboard in Arabic and English → one column, no horizontal scroll at 320, 360, and 430, every tap target at least 44 by 44, at most four tabs in the bottom bar, cards open a drill down → AC-20
- [ ] Below 640px the sample table becomes cards that carry the same chips → AC-20
- [ ] Focus a `HelpHint` and press Enter or Space → its popover opens with one or two sentences; Esc closes and focus returns to the button → AC-21
- [ ] Focus outside a text field and press `?` → the help panel opens from the start edge; inside a text field `?` types a character and nothing opens; Esc closes and focus returns to where it was → AC-21
- [ ] The help panel shows the steps, the outcome glossary with real chips, and a settings driven number (change the sample setting and the sentence changes) → AC-21
- [ ] Dismiss the first run checklist, then restore it from the help panel → AC-21
- [ ] On a coarse pointer, the sample confirmation queue card's outcome buttons each measure at least 48 by 48 and the focus ring is the direction's width; each button shows its shortcut → AC-22
- [ ] The Arabic specimen under `lang="ar"` renders in the chosen Arabic face, looks at least as large as the Latin beside it, and has line height at least 1.7; a SKU inside an Arabic name keeps its order → AC-23
- [ ] Network log on a production build → no request to a font host; the portal sample requests one Arabic weight pair and shows text before it loads → AC-23

### Value sourcing

- [ ] Meaning aliases: `confirmed`, `failed`, `owed`, `provisional` resolve to the success, destructive, warning, and muted foreground tokens in light and dark (inspect computed values) → AC-16
- [ ] Brand tokens: `--brand` and `--brand-foreground` come from the accent prop, never from a baked value; with no accent the portal uses the neutral primary → AC-19
- [ ] Help policy numbers (no answer count, callback delay) come from settings, not from the message text → AC-21
- [ ] Every frame, chip, and help string comes from the message catalog through props or `t()`, in both languages → AC-18, AC-21

### Commands

- [ ] `pnpm lint` → passes, including the logical CSS check on the new components → AC-18
- [ ] `pnpm format:check` and `pnpm typecheck` → pass → AC-15
- [ ] `pnpm --filter @ssdashboard/ui test` → every new component has an axe check in light, dark, and `dir="rtl"`; the chip test fails if an icon or a word is missing; the `deriveBrandTokens` tests cover `#0A7C39`, `#F2C230`, and a refused pale yellow → AC-16, AC-17, AC-19
- [ ] `pnpm test:e2e` → the `shell.spec.ts` axe matrix (light and dark × left to right and right to left × `/` and `/design`) shows zero violations with the new sections; the 360 by 800 touch tests, the help keyboard tests, and the 48px queue targets pass → AC-15, AC-18, AC-20, AC-21, AC-22
- [ ] Delete one Arabic `help.*` key and run `pnpm test` → the missing key test fails; restore it → AC-21
- [ ] `node packages/config/scripts/check-doc-links.mjs` → passes → AC-15

### Acceptance-criteria coverage (amendment)

- AC-15 chosen direction applied and measured: `/design` contrast step, axe matrix, `pnpm typecheck`
- AC-16 status roles and chips: row table steps, grayscale step, chip tests, meaning alias step
- AC-17 provisional display: provisional total step, right to left step, freshness strip step
- AC-18 three frames: Frames step, `pnpm lint`, copy from catalog step
- AC-19 brand theming: accent steps, `deriveBrandTokens` tests, brand tokens step
- AC-20 phone dashboard: 360 by 800 steps, table to cards step, Playwright touch tests
- AC-21 in screen help: hint, panel, checklist steps, missing key test, policy numbers step
- AC-22 dense surfaces and floor scope: 48px queue step, shortcut step
- AC-23 Arabic type and fonts: Arabic specimen step, font network step
