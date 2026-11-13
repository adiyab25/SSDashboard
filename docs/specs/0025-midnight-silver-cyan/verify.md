# Verify: Midnight, Silver and Cyan · spec 0025 · written 2026-11-13

_Steps derived from the acceptance criteria of [spec 0025](index.md). `/check verify` runs these; `/test` locks the durable ones. Commands run from the repository root. Milestone numbers say when a step first applies._

## Contrast numbers (reproduce the spec's tables)

The numbers in [index.md](index.md) use the same WCAG 2 formula as `apps/web/src/design/contrast.ts` and are guarded by three committed checks:

- `packages/ui/src/styles/tokens.spec.ts`: token values.
- `apps/web/e2e/design-contrast.spec.ts`: every pair live on `/design`, dark and light. Opaque pairs match the published figure within 0.02; pairs measured over a translucent tint (selected row, current page, hover tints) are measured as painted and match within 0.1.
- `apps/web/e2e/design-motion-density.spec.ts`: motion, reduced motion, density, and the right to left mirroring of gradients.

```bash
pnpm --filter @ssdashboard/ui test
pnpm --filter @ssdashboard/web test:e2e -- design-contrast
pnpm --filter @ssdashboard/web test:e2e -- design-motion-density
```

Expect to find these key figures: `foreground` on `background` 15.75 dark and 17.99 light; cyan link on the page 11.60 and 4.98; `input` on control fill 3.25 and 3.88; owed chip 8.98 and 4.82; light cyan on `accent` 4.21 (the failing pair AC-5 forbids); `foreground` on the selected row tint 10.85 and 16.81.

## Automated

| AC | Command or test | Expect |
|---|---|---|
| AC-1 | `pnpm --filter @ssdashboard/ui test` (token spec) | every role equals the table; no Daftar value left |
| AC-2, AC-3, AC-5 | `pnpm --filter @ssdashboard/web test:e2e -- design-contrast` (or the repo's name for the Playwright contrast spec) | every pair at or above its need, live number within 0.02 of the table (0.1 for tint pairs, measured as painted) |
| AC-4 | `pnpm --filter @ssdashboard/ui test` (status chip spec) and `rg -n "bg-primary\|text-primary\|ring" packages/ui/src/status` | no `primary`, `ring`, or blend class in any status component |
| AC-6 | `pnpm --filter @ssdashboard/ui test` (`status-chip.spec.tsx`) | four meanings, each icon plus word, blank label renders nothing; Playwright computed style 24px, 6px radius |
| AC-12 | token spec, then Playwright computed style per component on `/design` | 6, 8, 10, 12px as named |
| AC-14 | `pnpm --filter @ssdashboard/web build` with the network off; `git diff --stat main -- package.json pnpm-lock.yaml pnpm-workspace.yaml apps/web/package.json packages/ui/package.json`; the `fonts-production` Playwright spec | build passes; no dependency change; no font host request; families Geist and Geist Mono |
| AC-11 | `git diff main --stat -- packages/i18n apps/web/src/i18n` | empty |
| AC-13, AC-18, AC-19 | `pnpm --filter @ssdashboard/web test:e2e -- design-motion-density`; Playwright projects with and without `reducedMotion: 'reduce'` | normal: 180ms on transform, box-shadow, colours; hover on a button gives `translateY(-1px)`. Reduced: `transform: none` on hovered and pressed buttons, no running animation on a page section, no sheen |
| AC-20 | `pnpm --filter @ssdashboard/web test:e2e -- shell` and `git diff main -- packages/ui/DESIGN.md` on the density section | geometry assertions pass unchanged; no density number changed |
| AC-21 | `pnpm test` and `pnpm test:e2e` | pass; the pull request lists every test line changed and each one is a colour, font, or class assertion |
| AC-22 | the axe Playwright specs for each milestone's screens | zero violations in dark and light, left to right and right to left |
| AC-23 | `pnpm lint` (runs `lint:repo`) and `rg -n "Daftar\|Inter\b\|JetBrains" --glob '!docs/specs/**' --glob '!docs/positioning/**' --glob '!docs/reviews/**' --glob '!docs/handover/**' .` | lint passes; no remaining hit outside history |

Whole repository gate at the end of every milestone: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`.

## UI / manual

Milestone 1 (`/design`, in development, `pnpm dev`):

- [ ] Open `/design` in dark. The palette shows every role of the dark column, the gradients show each utility, and the contrast section lists every pair with a live number matching the table in index.md → AC-1, AC-2, AC-3
- [ ] Switch to light from the user menu. Same page, light column. The pairs AC-5 forbids (cyan, confirmed, owed text on `accent`) are shown as "not allowed on accent", not as a passing pair → AC-5
- [ ] Look at the status chip row. Each meaning has its own icon, a word, the control fill, a glow on the icon, and no plain dot → AC-6
- [ ] Look at the button matrix: main button (blend, edge, weight 600), secondary (control fill, gradient edge, both ends visible against page and card), disabled (card fill, muted text, no lift), hover shows a 1px lift and the sheen on the main button, press shrinks slightly → AC-7, AC-18
- [ ] Focus every control with Tab. The cyan ring is visible on page, card, control fill, sidebar, and `accent` → AC-8, AC-22
- [ ] Open a select and a menu: 10px corners, 6px rows, 150ms drop. Trigger a toast: inverted colours, Undo when undoable. Trigger an error toast: destructive surface with a destructive border. An info notice has the "i" icon and muted text, no cyan → AC-10, AC-12, AC-18
- [ ] Segmented control: none is vendored yet, so confirm the `DESIGN.md` rule is there. When one is vendored, select a segment: it gets the `accent` fill and a 1px `input` border → AC-9
- [ ] Read the page heading: 20px, the blend fill. Switch the system to forced colors (Windows High Contrast): the heading reads in the plain foreground → AC-11
- [ ] Switch to Arabic and right to left: section label `//` stays correct, table headers read normally, heading letters join (no gaps), digits stay Western, tinted gradients fade from the right edge, Arabic text in a mono styled label is in Noto Sans Arabic → AC-13, AC-15
- [ ] Turn on "reduce motion" in the operating system: hover and press no longer move anything; no entrance, sheen, or pulse → AC-19
- [ ] Show the light theme to the owner. Write the approval (or the changed values) under "Light theme approval" in index.md → AC-17
- [ ] Open the fonts README: the Geist and Geist Mono rows have the real version from the font `name` table, the `unicode-range`, the weight range, and the licence link; it states whether `tnum` exists → AC-14, AC-16

Milestones 2 to 7 (each batch, in dark and light, English and Arabic):

- [ ] M2: sign in, the five `(auth)` screens, then the shell: sidebar current page has the tint and the 2px marker on the start edge (mirrored in Arabic), top bar, location switcher, command palette (Ctrl+K), user menu. Heights match before: top bar 56px, sidebar item 32px → AC-13, AC-20, AC-22
- [ ] M3: orders list (lowercase mono headers, row hover and selected tint, chips with glow, column order code, who, where, how much, state, cash), order page, new order → AC-6, AC-11, AC-21
- [ ] M4: stock, three receipts screens, SKUs, styles, product groups, seasons, locations; forms use the field look → AC-8, AC-9, AC-21
- [ ] M5: customers list, profile, merge, two connections screens; a provisional amount still shows `≈`, the dashed boundary, and the hidden label → AC-21
- [ ] M6: home, staff, audit, settings, cost rules, account; info notices are muted with the "i" icon → AC-10
- [ ] M7: portal returns and previews, partner pages and preview; brand accent colours only the logo tile, top rule, and the main portal button; no request to a font host (devtools network panel) → AC-14, AC-22
- [ ] Each batch: axe shows zero violations on each screen in the four theme and direction combinations; Tab reaches every control with a visible ring; no screen shows a string, route, permission, or table column that differs from before → AC-21, AC-22

## Things that can fail quietly

- Axe may report the gradient `h1` as "incomplete" instead of passing it. Record what it says in M1 and rely on the stop by stop table plus the plain fallback.
- A component that still carries an old Daftar class (an indigo, a radius multiplier, a tinted chip surface) passes lint. The AC-23 grep and the token spec catch the leftovers.
- A hover tint in light that uses `accent` instead of the ink tint puts text on `accent`; check any link, owed flag, or status text inside a hovered row (AC-5).
