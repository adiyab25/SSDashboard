# 0025. Midnight, Silver and Cyan: a new look for the design system (colour, typeface, corners, motion, base components), with the behaviour rules of spec 0003 kept

**Date**: 2026-11-13
**Status**: Proposed (the owner chose the look and every decision in [Decisions](#decisions); the owner approved the light theme on `/design` on 2026-11-14 with one change, see [Light theme approval](#light-theme-approval))
**Scope feature**: 5, Design system and UI foundation (done), amended. No new scope feature: this changes the look of a built feature, and the screens are restyled in milestones M2 to M7 below.
**Amends**: [spec 0003](../0003-design-system-ui-foundation/index.md). Option B, "Daftar", is replaced as the look. Everything behavioural in spec 0003 stays.
**Source design**: the owner's design spec "Midnight, Silver and Cyan" (a folder outside this repository, read only: `DESIGN-SPEC.md` and the reference screens `DSheet`, `DComponents`, `DSsdOrders`). Where the design spec and a screen disagreed, the design spec was followed.

## Summary

The back office, the sign in screens, the public portal, and the partner surface get a new look: a deep blue black page (`#0A0E14`), silver text, and one ice cyan (`#7DD3FC`) that means "link, focus, current page" and nothing else. The main action of a view is a silver to cyan gradient button. Headings carry a soft silver to cyan fill, section labels read like code comments (`// orders`), tables use lowercase mono headers, status chips glow, and everything moves with one easing curve. Geist and Geist Mono replace Inter and JetBrains Mono. The dark theme is the design exactly as the owner specified it. The light theme is derived from the same roles and is shown on `/design` for approval before any screen changes.

This spec changes the look only. It does not change behaviour, routes, data, permissions, wording, the fixed table column order, or density. The row, control, and type sizes in [`packages/ui/DESIGN.md`](../../../packages/ui/DESIGN.md) stay exactly as they are (40px controls and rows, 44px table header, 32px sidebar items, 15px body, the `floor` scope). The mockups' 44 and 46px sizes and 14px body are not adopted.

## Requirements

**User stories**:

- As a staff member who looks at tables all day, I want a calm dark screen where the one colour I see means something, so that links, focus, and status stand out.
- As a user who prefers a light screen, I want the Light, Dark, and System switch to keep working with a light look that matches, so that nothing is lost.
- As an Arabic speaking user, I want the new look to read correctly right to left, with Arabic text in an Arabic face and gradients that run along the line, so that the mirror is complete.
- As a keyboard or screen reader user, I want every pair of colours to meet the same contrast rules as before, so that the new look is never less accessible than the old one.
- As a user who asked for less motion, I want hover lifts, sheens, and entrances switched off, not only shortened.
- As a developer, I want the look in tokens and a few named utilities, so that screens change by using role tokens and never by hard coding a colour.

**Acceptance criteria** (numbered AC-1 and up for this spec; each says how it is checked, and [verify.md](verify.md) has the steps):

*Tokens and contrast*

- **AC-1** (tokens): `packages/ui/src/styles/globals.css` carries the values of the [token tables](#colour-tokens) exactly, dark in `.dark` and light in `:root`, for every role listed, and no Daftar value (the indigo primary, the warm paper neutrals, the `oklch(... 275)` and `oklch(... 70)` families) remains. Checked by a Vitest spec in `packages/ui` that reads the file and compares each role to the table.
- **AC-2** (contrast, text and controls): every text pair in [Measured contrast](#measured-contrast) meets 4.5:1 (3:1 for large text and for the focus ring and control boundaries), in dark and light, and `/design` computes every pair live from the painted colours and shows the same numbers to within 0.02 for opaque pairs and within 0.1 for pairs measured over a translucent tint (selected row, current page, hover tints), which are measured as painted. Checked by `packages/ui/src/styles/tokens.spec.ts` and the Playwright spec `apps/web/e2e/design-contrast.spec.ts`.
- **AC-3** (gradient stops): every gradient stop that sits behind text passes 4.5:1 on its own (3:1 for the stops of the large heading fill), the main button blend, the hero blend, the heading blend, the selected row tint, and the current page tint, in both themes. `/design` lists each stop with its ratio. Checked by the same Playwright spec (`design-contrast.spec.ts`).
- **AC-4** (accent never means status): cyan (`primary`, `ring`) and the gradient blends carry only links, focus, the current page, the main action, and the selected row tint. Status uses `success`, `warning`, `destructive`, and the muted foreground only. Amber `warning` means "owed" on status chips and "needs attention" on notices (decision 13); cyan is never status. Checked by a Vitest spec that renders every `StatusChip` meaning and asserts its class list holds none of `primary`, `ring`, or a blend utility, and by a repository grep recorded in verify.md.
- **AC-5** (text on `accent`): every text pair on `accent` passes in both themes, measured on `/design` with light `accent` `#E9EEF4`: `foreground` 16.58, `muted-foreground` 6.45, `primary` (link) 4.59, confirmed 4.70, owed 4.65, failed 4.99, all at or above 4.5. Row hover is the `tint-row` utility in both themes. Checked by the contrast table and by a story on `/design` that renders hovered and selected rows with a link and an owed flag inside.

*Look of base components*

- **AC-6** (status chips): `StatusChip` is the control fill, 1px `border-strong`, mono 12px lowercase text in the meaning colour, 24px tall, 6px corners, keeps its distinct icon per meaning (check for confirmed, X for failed, coins for owed, clock for provisional), and the icon carries the glow (`drop-shadow` of the meaning colour at 8px). No plain dot. A blank label still renders nothing. Checked by the existing `status-chip.spec.tsx` updated, plus a computed style check in Playwright.
- **AC-7** (buttons): the main button uses the primary blend, the primary edge, weight 600, and is one per view as before. The secondary button is the control fill with the [secondary edge](#gradients-and-utilities), a gradient from a lighter slate down to the `input` colour in dark (and from a darker slate down to `input` in light), so both ends of the edge reach 3:1 on the page and on a card. Disabled is the card fill, muted text, no lift. Checked by contrast rows in the table and the button matrix on `/design`.
- **AC-8** (fields): inputs and selects are the page colour (the card colour on a card in light) with the `input` boundary and 8px corners; focus is the 2px cyan `ring` outline with the project's 2px offset; an error uses the `destructive` boundary and the message below. Checked by `field-states` on `/design` and axe.
- **AC-9** (segmented control): no segmented control or toggle group is vendored yet and no screen uses one, so until then this is satisfied by the rule in `packages/ui/DESIGN.md`. It applies the first time one is vendored (the first milestone that needs one, probably M4): the track is `card` with a hairline, and the selected segment is `accent` with `foreground` text and an additional 1px `input` coloured border. Checked then by a component test and the `/design` button matrix; the pair itself (`input` on `card`, 3.56 dark and 4.36 light) is already in the contrast table.
- **AC-10** (feedback): a toast is inverted (`foreground` background, `background` coloured text) with Undo when the action can be undone; an error toast is the `destructive-surface` with a `destructive` border. Notices that are not errors use `muted-foreground` text with an "i" icon, never cyan. A needs-attention warning notice (for example the online stock warning) instead uses the `Alert` `warning` variant: amber `warning` border and text with the triangle icon. Checked by component tests (including one for the warning variant), the pairs in the table, and the M4 look spec.
- **AC-11** (headings and labels): the page `h1` stays at 20px (`text-xl`) and gets the heading blend as its fill, with a plain `foreground` fallback when forced colours are on or `background-clip: text` is unsupported; section titles keep their sizes. Section labels show `// ` in cyan before a lowercase mono label (CSS only). Table headers are lowercase mono through `text-transform: lowercase` only. No message catalog changes, and Arabic text is untouched by both. Checked by `git diff` showing no change under `packages/i18n` and `apps/web/src/i18n`, and by computed style checks in Playwright.
- **AC-12** (corners): four named radius tokens exist and are used by the components: `chip` 6px (chips and menu rows), `control` 8px (buttons, fields), `popover` 10px (popovers, menus, tooltips), `card` 12px (cards, dialogs). Checked by the token spec and a computed style check per component on `/design`.
- **AC-13** (surfaces): cards use the card edge gradient border (12px corners, 18 to 20px padding stays within the existing density scale: the padding the card has today does not change), sidebar items use the hover tint, and the current page gets the tint and a 2px marker on the leading edge. Gradients that run along the line mirror in right to left (an `rtl:` variant or logical gradient direction). Checked by Playwright computed style in both directions.

*Type*

- **AC-14** (fonts): Geist and Geist Mono are self hosted as latin subset variable woff2 files in `apps/web/src/shell/fonts/` with their OFL texts in `apps/web/public/licenses/fonts/`; the Inter and JetBrains Mono files and licence texts are removed; `package.json` and `pnpm-lock.yaml` gain no new dependency; the browser makes no request to a font host (build or runtime). `--font-sans` and `--font-heading` are Geist, `--font-mono` is Geist Mono, `--font-arabic` is Noto Sans Arabic then Geist. `LtrText` codes use Geist Mono and stay left to right. Checked by `pnpm --filter @ssdashboard/web build` with the network blocked, the existing `fonts-production` Playwright spec updated to the new families, and `git diff --stat` on the two package files.
- **AC-15** (Arabic and mono): under `lang="ar"`, mono styled labels (section labels, table headers, chips) fall through Geist Mono to Noto Sans Arabic for Arabic glyphs (the mono stack lists it), heading letter spacing is reset to 0 (negative spacing breaks cursive joining), and Western digits stay Western. Checked by a Playwright screenshot review of an Arabic table and by a computed style check.
- **AC-16** (tabular figures): numeric columns still align. Geist's `tnum` feature is checked in the font file in M1; if it is missing, `tabular-nums` columns use Geist Mono instead and the choice is recorded in `DESIGN.md`. Checked by a font table inspection recorded in the fonts README.

*Light theme gate*

- **AC-17** (owner approval before screens): the light values are shown on `/design` (palette, gradients, every measured pair) and the owner approves or changes them before M2 starts. The approval (date and any changed value) is written under [Light theme approval](#light-theme-approval) in this spec. Checked by that line being filled in. **Satisfied 2026-11-14** by the approval line (accent changed to `#E9EEF4`).

*Motion*

- **AC-18** (motion): the transitions run 180ms on transform, box-shadow, and colours with the easing `cubic-bezier(.2,.7,.2,1)`; a button lifts 1px with a shadow on hover; the main button sheen sweeps 600ms; press scales to .98; page sections enter with a fade and an 8px rise over 500ms, staggered 50ms with a 200ms maximum delay; a dropdown opens in 150ms with a 4px drop; the skeleton pulses 1.4s. Checked by computed style in Playwright.
- **AC-19** (reduced motion): under `prefers-reduced-motion: reduce` all of that is off, including the hover lift and the press scale (no transform), the sheen, the entrance, and the pulse. The existing global rule only shortens durations and is not enough. Checked by a Playwright project with `reducedMotion: 'reduce'` asserting `transform: none` on hovered and pressed buttons, and no running animation on a section.

*Unchanged things*

- **AC-20** (density unchanged): the measured sizes are the same before and after: controls 40px (48px in `floor` on touch), table rows 40px, table header 44px, sidebar items 32px, top bar 56px, body 15px, status chip 24px. A table row that holds a button is also 40px: its cells drop vertical padding around the 32px `sm` button, and the button is not shrunk; the exceptions are a row that shows an explanatory note under its action (the in-use note on `/seasons` and `/product-groups`, about 52px in English and about 60px in Arabic, when the note fits on one line; in a narrow table the note wraps (it is never cut or hidden behind a sideways scroll) and the row grows to fit, up to about 82px in Arabic) a style page SKU row whose cost cell shows its second line ("from <date> · from the style", 58 to 63px), a merge suggestion row on `/customers` (review tab), whose two line customer cell (the name with the phone below) sits beside the Merge and Dismiss buttons (measured at 1280px: about 48 to 73px in English, about 59px in Arabic), and a connection row on `/connections` that shows a health reason or warning sentence (about 77 to 80px; rows without a sentence stay 40px), an `/audit` list row, whose Record cell shows the record type over its number (about 55px in English and about 59px in Arabic at 1280px), and a `/staff` row on the people and partner logins tabs in Arabic, where the table cannot hold the name, the email, and the last sign in date (kept on one line) on one line, so a row whose name or email cell wraps grows to fit it (about 56 to 57px at 1280px; Arabic rows whose cells fit and every English row stay 40px); each grows to fit because that text is never hidden or truncated (decision 14). Checked by the existing `shell.spec.ts` geometry assertions passing unchanged and a diff of the density section of `DESIGN.md` showing no number changed.
- **AC-21** (behaviour unchanged): no route, data call, permission, string, or table column order changes. Checked by `pnpm test` and `pnpm test:e2e` passing, where any changed test line is a look assertion (a colour, a font name, a class), listed in the milestone's pull request.
- **AC-22** (accessibility and directions): axe reports zero violations on every restyled screen in dark and light, left to right and right to left; keyboard focus is visible on every control; every target is at least 24 by 24px as before. Checked by the existing axe Playwright specs extended to each milestone's screens.

*Docs*

- **AC-23** (docs stay true): `packages/ui/DESIGN.md` look sections are rewritten (colour, type, radius, motion, status chips, components' look) and keep the behaviour and rule sections, with the measured contrast table of this spec; `packages/ui/AGENTS.md`, `apps/web/AGENTS.md`, the fonts README, and the other lines listed in [Docs that go false](#docs-that-go-false) are updated; spec 0003 says it is amended by this spec. Checked by `pnpm lint:repo` and a grep for `Daftar`, `Inter`, and `JetBrains` outside spec history.

## Decisions

Each decision was made by the owner. The reason is the reason given with it.

1. **Token mapping** (the existing role, then dark and light values, in [Colour tokens](#colour-tokens)). Reason: the existing role names stay, so no component API changes; only values change. Chip surfaces become the control fill (no colour tint) because the new design shows status by text colour and a glow, not a tinted wash.
2. **Secondary button edge** keeps the gradient look but runs from a lighter slate down to the `input` colour. Reason: the design spec's 25 percent to 8 percent white edge measures 1.2 to 2.2:1 against the page and card, which fails the 3:1 rule for a control boundary. The new edge measures at least 3.56:1 at its weakest end.
3. **Status chips** keep distinct icons per meaning (check, X, coins, clock) and gain the glow; no plain dot. Reason: the project's rule is an icon and a word together (spec 0003 AC-16); the design's plain dot would be colour plus a dot of the same shape for every meaning.
4. **Page heading stays 20px** (`text-xl`) and gets the heading blend; no 34px display size. Reason: density and type sizes are not part of this change.
5. **Info role**: notices use `muted-foreground` with an "i" icon, except a needs-attention warning (decision 13). Info never uses cyan. Reason: cyan means link, focus, and current page; an info message in cyan would look like a link.
6. **`//` section labels and lowercase mono table headers** are included, by CSS only. The bottom status bar, the breadcrumb path, and new keyboard hint chips are left out. Reason: they add content or behaviour, and this change is the look only.
7. **Segmented control**: the selected segment also gets a 1px `input` border. Reason: the selected fill against the track is only 1.35:1, so the border gives the 3:1 boundary.
8. **Fonts**: Geist and Geist Mono, latin subset variable woff2, self hosted; OFL texts included; Inter and JetBrains Mono files removed; no new npm dependency. `--font-arabic` is Noto Sans Arabic then Geist. Codes use Geist Mono and stay left to right. Reason: the design uses them, self hosting keeps the rule that no font host is contacted (spec 0003 AC-23), and Noto Sans Arabic stays because Geist has no Arabic glyphs.
9. **Radius tokens are explicit**: 6px chips and menu rows, 8px buttons and fields, 10px popovers and menus, 12px cards and dialogs. Reason: today one `--radius` is scaled by multipliers, and the new look needs four distinct values to hold.
10. **Motion**: as in AC-18, all off under reduced motion including the lift. Reason: the existing global rule only shortens durations, and a lift that still moves is the motion some users asked to turn off.
11. **Toast**: inverted, Undo when undoable; the error toast uses the destructive surface with a destructive border. Reason: the design.
12. **Density unchanged.** Measured contrast as in the tables; two chart colours fail 3:1 and are owed to the chart spec (see [Out of scope](#out-of-scope-and-owed)).
13. **Warning notices are amber** (owner ruling, 2026-11-14, during M4). A notice that says something needs attention uses the `warning` variant of the shared `Alert`: amber border and text with the triangle icon. The first user is the online stock notice, "No location feeds online stock: Shopify is not being updated" (`apps/web/src/inventory/online-status-notice.tsx`). Amber now means "owed" on status chips and "needs attention" on notices; cyan is still never status. Reason: an operational warning that Shopify is not being updated must stand out from quiet info notices, and amber already passes AA on `card` (9.84 dark, 5.42 light, see the pair table). Owner ruling (2026-11-19, during M6): the setting change consequence messages (the `entry.warning` text in `apps/web/src/settings/setting-change-dialog.tsx` and `apps/web/src/settings/step-on-dialog.tsx`, for the time zone, prices include VAT, sales tax rate, operating day cutoff, store product group, and Shopify stock safety buffer settings) are needs-attention notices, so they use the `warning` variant with the triangle icon; "It stays waiting until its work is running again" (step on dialog) and "Nothing is locked yet, so a rule can start on any day" (cost rules) stay info notices, `muted-foreground` text with the "i" icon; the wording is unchanged.
14. **Rows with a button stay 40px** (owner ruling, 2026-11-14, during M4). The 40px table row of AC-20 also applies to rows that hold a button: the cells drop their vertical padding around the 32px `sm` button, and the button is not shrunk. The exceptions are a row that shows an explanatory note under its action (the in-use note on `/seasons` and `/product-groups`), which grows to fit the note (about 52px in English and about 60px in Arabic, when the note fits on one line; in a narrow table the note wraps (it is never cut or hidden behind a sideways scroll) and the row grows to fit, up to about 82px in Arabic), and, by a second ruling the same day, a style page SKU row whose cost cell shows its second line ("from <date> · from the style"), which grows to fit it (58 to 63px); and, by a ruling on 2026-11-16 during M5, a merge suggestion row on `/customers` (review tab) grows to fit its two line customer cell (name with phone below) beside the Merge and Dismiss buttons, with no layout change (measured at 1280px: about 48 to 73px in English, about 59px in Arabic), and a connection row on `/connections` that shows a health reason or warning sentence grows to fit it like the in-use note rows, its text never truncated or hidden behind a sideways scroll (about 77 to 80px; rows without a sentence stay 40px); and, by a ruling on 2026-11-19 during M6, an `/audit` list row grows to fit its two line Record cell (the record type over its number), about 55px in English and about 59px in Arabic at 1280px, and a `/staff` row on the people and partner logins tabs in Arabic, where the table cannot hold the name, the email, and the last sign in date (kept on one line) on one line, grows to fit a wrapped name or email cell, about 56 to 57px at 1280px (Arabic rows whose cells fit and every English row stay 40px), both with no layout change and with their text never truncated or hidden behind a sideways scroll. Reason: density is unchanged (decision 12), so a button must not make a row taller, but the note is never hidden or truncated, so it gets the room it needs.

## Design

### Colour tokens

Role names are the existing ones in `globals.css`. Dark is the owner's design exactly. Light is derived and owner approved on 2026-11-14 (AC-17), with `accent` changed to `#E9EEF4`. Alpha values are written as eight digit hex (`#RRGGBBAA`) and painted over the surface they sit on.

| Role | Dark | Light | Notes |
|---|---|---|---|
| `background` | `#0A0E14` | `#F4F7FA` | page |
| `sidebar` | `#0C1119` | `#EBF0F5` | chrome (sidebar) |
| `card` | `#111722` | `#FFFFFF` | cards, panels, tables |
| `popover` | `#18202C` | `#FFFFFF` | menus, popovers |
| `secondary`, `muted` | `#18202C` | `#EEF2F6` | control fill (secondary button, chips, table header fill) |
| `accent` | `#243044` | `#E9EEF4` | hover and selected (menu focus, selected segment) |
| `foreground` | `#E6E8EB` | `#0A0E14` | text; `card-foreground`, `popover-foreground`, `sidebar-foreground`, `secondary-foreground`, `accent-foreground` equal it |
| `muted-foreground` | `#9AA6B8` | `#4A5568` | labels, captions, table headers, info notices |
| `primary`, `ring` | `#7DD3FC` | `#0E7490` | cyan alone: links, focus, current page |
| `primary-foreground` | `#0A0E14` | `#FFFFFF` | text on solid cyan |
| `border` | `#FFFFFF14` | `#0A0E1414` | decorative hairline (exempt from 3:1) |
| `input` | `#5F7088` | `#6B7A90` | control boundary, 3:1 |
| `success` (confirmed) | `#7EE0B0` | `#047857` | `success-foreground` is `#0A0E14` dark, `#FFFFFF` light |
| `warning` (owed, needs attention) | `#E8B86D` | `#9A5B0B` | `warning-foreground` same rule |
| `destructive` (failed) | `#FF8A8A` | `#C02A2A` | `destructive-foreground` same rule |

Sidebar aliases: `sidebar-primary` and `sidebar-ring` equal `primary`; `sidebar-primary-foreground` equals `primary-foreground`; `sidebar-accent` equals `accent`; `sidebar-border` equals `border`. **Assumed**: the owner's mapping did not list these, so they follow their parents.

Meaning roles (spec 0003 AC-16) keep their aliases: `confirmed` is `success`, `failed` is `destructive`, `owed` is `warning`, `provisional` is `muted-foreground`. Their `*-surface` roles become the control fill (`muted`), with no colour tint. `info` is `muted-foreground` and `info-surface` is `muted` (decision 5). `brand` defaults to `primary` and `brand-foreground` to `primary-foreground` as before.

New roles:

| Role | Dark | Light | Use |
|---|---|---|---|
| `border-strong` | `#FFFFFF1F` | `#0A0E141F` | chip border, table header rule |
| `destructive-surface` | `#2A1A1C` | `#FDECEC` | error toast, error block |
| `primary-edge` | `#BFE6FB` | `#0B5568` | main button edge. **Assumed**: the owner asked for "a dark cyan for light"; `#0B5568` is my pick, measured 7.77 on the page and 8.35 on a card |

### Gradients and utilities

Gradients are utilities in `globals.css`, not colour variables, so a gradient is used by name. Dark values are the design's; light values are the owner's approved starting point. Each utility sets the light value and overrides it with the project's `dark` variant.

| Utility (built in `globals.css`) | Dark | Light |
|---|---|---|
| Primary blend (main button fill, text `primary-foreground`) | `linear-gradient(110deg, #F4F7FA 0%, #C9D3DE 34%, #FFFFFF 48%, #A9DDF8 64%, #7DD3FC 100%)` at `background-size: 220% 100%` | `linear-gradient(110deg, #1E293B 0%, #334155 40%, #0E7490 100%)`, white text |
| Heading blend (page `h1` text fill) | `linear-gradient(100deg, #FFFFFF 0%, #C9D3DE 45%, #7DD3FC 100%)` | `linear-gradient(100deg, #0A0E14 0%, #334155 45%, #0E7490 100%)` |
| Hero blend (hero tile, later) | `linear-gradient(110deg, #F4F7FA, #C9D3DE 40%, #A9DDF8 70%, #7DD3FC)` | `linear-gradient(110deg, #1E293B, #334155 40%, #155E75 70%, #0E7490)`, white text. **Assumed**: the owner gave the light primary and heading blends only; this one adds `#155E75` in the middle (white on it 7.27) |
| Card edge (1px gradient border, padding box plus border box) | `linear-gradient(180deg, #FFFFFF33, #FFFFFF0D)` | `linear-gradient(180deg, #0A0E1424, #0A0E140D)` (ink at 14 percent to 5 percent) |
| Secondary edge | `linear-gradient(180deg, #8A9BB2, #5F7088)` | `linear-gradient(180deg, #475569, #6B7A90)` |
| Glow (behind hero areas, later) | `radial-gradient(110% 90% at 50% 0%, #7DD3FC30 0%, #7DD3FC0F 38%, transparent 72%)` | the same with `#0E749026` and `#0E74900D` |
| Grid (faint, 32px) | 1px lines of `#FFFFFF08` | 1px lines of `#0A0E1408` |
| Selected row tint | `linear-gradient(90deg, #7DD3FC24, transparent 70%)` | `linear-gradient(90deg, #0E74901A, transparent 70%)` |
| Current page tint (sidebar) | `linear-gradient(90deg, #7DD3FC29, #7DD3FC05)` | `linear-gradient(90deg, #0E749024, #0E74900A)` |
| Current page marker (2px, leading edge) | `linear-gradient(180deg, #FFFFFF, #7DD3FC)` | `linear-gradient(180deg, #0A0E14, #0E7490)` |

Names that exist in `packages/ui/src/styles/globals.css`: the gradient rows above are `gradient-primary`, `gradient-heading`, `gradient-hero`, `gradient-card-edge`, `gradient-secondary-edge`, `gradient-glow`, `gradient-grid`, `gradient-selected-row`, `gradient-current-page`, and `gradient-current-marker`. The alpha only hover tints are `tint-nav` (sidebar item) and `tint-row` (table row). Look utilities with no gradient value: `section-label` (lowercase mono label with the cyan `// `) and `table-head-look` (lowercase mono header). Motion utilities: `transition-ui`, `lift`, `press`, `sheen`, `enter`, `enter-children`, `pop`, `pulse-ui`. Radii: `rounded-chip`, `rounded-control`, `rounded-popover`, `rounded-card`. New colour roles: `border-strong`, `destructive-surface`, `primary-edge`. Values and use of each: [`packages/ui/DESIGN.md`](../../../packages/ui/DESIGN.md).

Notes:

- The secondary edge top in dark, `#8A9BB2`, is **Assumed** (my pick, 6.83 on the page and 6.34 on a card). In light the edge runs from a darker slate (`#475569`, 7.05 and 7.58) down to `input`, because a lighter slate would lose contrast on a light page.
- Gradients that run along the line (selected row, current page, sheen) use `90deg` in left to right and `270deg` in right to left, so the strong end is always at the start edge (AC-13). The card edge runs top to bottom and does not mirror.
- The heading blend is a text fill (`background-clip: text`, `color: transparent`). It needs a plain `foreground` fallback under `@media (forced-colors: active)` and under `@supports not (background-clip: text)`.
- Gradients imitate light: an edge, a glow, a sheen. They never fill a whole surface (design spec section 1, atmosphere).
- Hover tint on a sidebar item: dark `#FFFFFF0A`, light `#0A0E140A`; table row hover: dark `#FFFFFF08`, light ink at 5 percent (`#0A0E140D`). These are alpha only utilities.

### Measured contrast

Method: the WCAG 2 formula, the same one `apps/web/src/design/contrast.ts` uses (sRGB channels to linear light, `(L1 + 0.05) / (L2 + 0.05)`). A translucent colour is painted over the surface it sits on first. The numbers below are guarded by committed checks, not scripts: `packages/ui/src/styles/tokens.spec.ts` (token values and the opaque pairs), `apps/web/e2e/design-contrast.spec.ts` (every pair, live on `/design`, in both themes), and `apps/web/e2e/design-motion-density.spec.ts` (motion, reduced motion, density, mirroring); [verify.md](verify.md) says how to run them. Opaque pairs match within 0.02; tint pairs are measured as painted, within 0.1. Thresholds: 4.5 for text, 3 for large text, the focus ring, and control boundaries.

**Text and controls**

| Pair | Dark | Light | Need |
|---|---|---|---|
| `foreground` on `background` | 15.75 | 17.99 | 4.5 |
| `foreground` on `card` | 14.63 | 19.34 | 4.5 |
| `foreground` on control fill | 13.35 | 17.19 | 4.5 |
| `foreground` on `accent` | 10.82 | 16.58 | 4.5 |
| `foreground` on `sidebar` | 15.41 | 16.87 | 4.5 |
| `foreground` on `popover` | 13.35 | 19.34 | 4.5 |
| `muted-foreground` on `background` | 7.85 | 7.00 | 4.5 |
| `muted-foreground` on `card` | 7.29 | 7.53 | 4.5 |
| `muted-foreground` on control fill | 6.65 | 6.69 | 4.5 |
| `muted-foreground` on `accent` | 5.39 | 6.45 | 4.5 |
| `muted-foreground` on `sidebar` | 7.68 | 6.56 | 4.5 |
| `primary` (link) on `background` | 11.60 | 4.98 | 4.5 |
| `primary` (link) on `card` | 10.77 | 5.36 | 4.5 |
| `primary` (link) on `accent` | 7.97 | 4.59 | 4.5 |
| `ring` on `background` | 11.60 | 4.98 | 3 |
| `ring` on control fill | 9.83 | 4.76 | 3 |
| `ring` on `sidebar` | 11.35 | 4.67 | 3 |
| `ring` on `accent` | 7.97 | 4.59 | 3 |
| `primary-foreground` on solid `primary` | 11.60 | 5.36 | 4.5 |
| `success` on `background` | 12.13 | 5.10 | 4.5 |
| `success` on `card` | 11.27 | 5.48 | 4.5 |
| `success` on control fill (chip) | 10.28 | 4.87 | 4.5 |
| `warning` on `background` | 10.60 | 5.04 | 4.5 |
| `warning` on `card` | 9.84 | 5.42 | 4.5 |
| `warning` on control fill (chip) | 8.98 | 4.82 | 4.5 |
| `destructive` on `background` | 8.52 | 5.42 | 4.5 |
| `destructive` on `card` | 7.91 | 5.82 | 4.5 |
| `destructive` on control fill (chip) | 7.22 | 5.18 | 4.5 |
| `destructive` on `destructive-surface` | 7.33 | 5.10 | 4.5 |
| `foreground` on `destructive-surface` | 13.54 | 16.93 | 4.5 |
| `success` on `accent` | 8.33 | 4.70 | 4.5 |
| `warning` on `accent` | 7.28 | 4.65 | 4.5 |
| `destructive` on `accent` | 5.85 | 4.99 | 4.5 |
| `success-foreground` on solid `success` | 12.13 | 5.48 | 4.5 |
| `warning-foreground` on solid `warning` | 10.60 | 5.42 | 4.5 |
| `destructive-foreground` on solid `destructive` | 8.52 | 5.82 | 4.5 |
| toast text (`background` on `foreground`) | 15.75 | 17.99 | 4.5 |
| `input` on `background` | 3.83 | 4.06 | 3 |
| `input` on `card` | 3.56 | 4.36 | 3 |
| `input` on control fill | 3.25 | 3.88 | 3 |
| `input` on `sidebar` | 3.75 | 3.81 | 3 |
| segmented selected border (`input`) on the track (`card`) | 3.56 | 4.36 | 3 |
| error boundary (`destructive`) on `background` | 8.52 | 5.42 | 3 |
| error toast border (`destructive`) on `destructive-surface` | 7.33 | 5.10 | 3 |
| main button edge (`primary-edge`) on `background` | 14.67 | 7.77 | 3 |
| main button edge on `card` | n/a (measured on page) | 8.35 | 3 |

The weakest control pairs are `input` on control fill in dark (3.25) and `input` on `sidebar` in light (3.81); the weakest text pairs are the cyan link on the light page (4.98) and the owed chip in light (4.82).

The segmented control's selected border is `input` on the selected `accent` fill at 2.63 in dark (light: 3.74 on `#E9EEF4`, was 3.43 on `#DCE5EE`). That is not a failing pair: the border's neighbour on the outside is the track, which is the pair that matters for a boundary (3.56 and 4.36); the fill inside is the control itself.

**Gradient stops behind or inside text** (each stop alone)

| Stop | Text on it | Dark | Light | Need |
|---|---|---|---|---|
| Primary blend `#F4F7FA` | `#0A0E14` | 17.99 | n/a | 4.5 |
| Primary blend `#C9D3DE` | `#0A0E14` | 12.76 | n/a | 4.5 |
| Primary blend `#A9DDF8` | `#0A0E14` | 13.25 | n/a | 4.5 |
| Primary blend `#7DD3FC` | `#0A0E14` | 11.60 | n/a | 4.5 |
| Primary blend `#1E293B` | `#FFFFFF` | n/a | 14.63 | 4.5 |
| Primary blend `#334155` | `#FFFFFF` | n/a | 10.35 | 4.5 |
| Primary blend `#0E7490` | `#FFFFFF` | n/a | 5.36 | 4.5 |
| Hero blend light `#155E75` | `#FFFFFF` | n/a | 7.27 | 4.5 |
| Heading blend `#FFFFFF` on `card` | (it is the text) | 17.96 | n/a | 3 (large) |
| Heading blend `#C9D3DE` on `card` | | 11.85 | n/a | 3 |
| Heading blend `#7DD3FC` on `background` | | 11.60 | n/a | 3 |
| Heading blend `#0A0E14` on `background` | | n/a | 17.99 | 3 |
| Heading blend `#334155` on `background` | | n/a | 9.63 | 3 |
| Heading blend `#0E7490` on `background` | | n/a | 4.98 | 3 |
| `foreground` on selected row tint | | 10.85 | 16.81 | 4.5 |
| cyan link on selected row tint | | 7.99 | 4.66 | 4.5 |
| owed flag on selected row tint | | 7.30 | 4.71 | 4.5 |
| `muted-foreground` on selected row tint | | 5.40 | 6.54 | 4.5 |
| `foreground` on current page tint (sidebar) | | 11.07 | 13.93 | 4.5 |
| `muted-foreground` on sidebar item hover | | 7.08 | 6.04 | 4.5 |
| `muted-foreground` on row hover | | 6.79 | 6.78 | 4.5 |
| owed flag on row hover | | 9.17 | 4.88 | 4.5 |
| `foreground` on row hover | | 13.63 | 17.43 | 4.5 |

Tints are translucent, so each pair is measured with the tint painted over its surface (the card, or the sidebar). The figures in the tint rows above are the values the browser paints and `/design` shows live (read from the running page; the browser rounds the tint's alpha to two decimals, which a script that keeps the full alpha does not). Tints are measured as painted with a tolerance of 0.1; every opaque pair keeps 0.02 (AC-2).

**Not a pair that matters.** The cyan marker as text on the light current page tint (3.88) is not allowed and is not used: the current page text is `foreground`, and the cyan is only the 2px marker, a non text mark that needs 3:1 (it has 4.67 on the light sidebar).

### Type

| Role | Face | Size and line | Weight |
|---|---|---|---|
| Page heading `h1` | Geist, heading blend fill, letter spacing -0.03em (0 in Arabic) | 20px (`text-xl`), line height as today | 600 |
| Section title | Geist | as today (17px `text-base`) | 600 |
| Body | Geist | 15px (`text-sm`), as today | 400, 500 for emphasis |
| Section label | Geist Mono, lowercase, `muted-foreground`, cyan `// ` before | `text-xs` (12px) | 400 |
| Table header | Geist Mono, lowercase by CSS only, `muted-foreground` | `text-xs`, row height as today | 400 |
| Codes, money, ids | Geist Mono, left to right, tabular | as the text around it | 400 to 500 |

- `--font-sans` and `--font-heading`: `var(--font-geist), ui-sans-serif, system-ui, sans-serif`.
- `--font-mono`: `var(--font-geist-mono), var(--font-noto-arabic), ui-monospace, monospace`. Noto Sans Arabic sits in the mono stack so Arabic text in a mono styled label does not fall to an arbitrary system face (Geist Mono has no Arabic glyphs; design spec section 2).
- `--font-arabic`: `var(--font-noto-arabic), var(--font-geist), ui-sans-serif, system-ui, sans-serif`.
- The `//` mark is `content: '// ' / ''` on a `::before` (the empty alternative text keeps it out of screen reader output) in cyan, inside an isolated left to right run. **Assumed**: alternative text syntax is supported by the browsers the project targets; M1 checks it and falls back to `content: '// '` plus a decorative span if not.
- The new font variables replace `--font-inter`, `--font-noto-arabic` stays, `--font-jetbrains-mono` is removed. Loaded in `apps/web/src/shell/root-fonts.ts` with `next/font/local` as today; files `geist-latin-variable.woff2` and `geist-mono-latin-variable.woff2`; licences `geist-OFL.txt` and `geist-mono-OFL.txt`.
- **Assumed**: the upstream for the files is the Geist repository (`vercel/geist-font`) for the licence texts and Google Fonts' woff2 for the latin subset, as the owner approved. I did not open either in this task. M1 records the real version from the font `name` table and the `unicode-range` and weight range in the fonts README, the way the existing README does.

### Radius, motion

Radius tokens in the `@theme` block: `--radius-chip: 6px`, `--radius-control: 8px`, `--radius-popover: 10px`, `--radius-card: 12px`, used by the components so `rounded-chip`, `rounded-control`, `rounded-popover`, and `rounded-card` exist. The old `--radius` multiplier set (`sm`, `md`, `lg`, `xl`) is removed or mapped onto these four so no component keeps an unnamed radius. The names are built as written.

Motion tokens: `--ease-ui: cubic-bezier(.2, .7, .2, 1)`, `--duration-ui: 180ms`. Named utilities (built, listed under Gradients and utilities): lift (1px up and `0 8px 24px #00000080` in dark, a softer shadow in light), press (`scale(.98)`), sheen (the primary blend's `background-position` from `100% 0` to `0 0` over 600ms with `0 8px 28px #7DD3FC40` in dark), enter (fade and 8px rise over 500ms, children staggered 50ms to a 200ms maximum), pop (150ms fade with a 4px drop), skeleton pulse (1.4s). Under `@media (prefers-reduced-motion: reduce)` each is set to no transform, no animation, and no transition, so the global rule that only shortens durations is replaced by a rule that removes the movement itself (AC-19).

### Components that change look (not behaviour)

Base components in `packages/ui/src/components/` (button, badge, card, input, select, textarea, checkbox and switch tracks, toggle and toggle group, tabs, table, dialog, sheet, popover, dropdown menu, command, tooltip, alert, skeleton, sidebar, sonner toast), plus `src/status/`, `src/frames/`, `src/dashboard/`, `src/help/` where they hard code the old look (the start stripe, tinted chip surfaces, the old radius classes, the indigo). Each keeps its props, its structure, its density classes (`h-control`, `h-row`, `h-row-header`, `h-nav-item`), and its accessibility attributes. The gallery in `apps/web/src/design/` gets the palette, the gradients, and every measured pair.

### Out of scope and owed

- **Out of scope**: the new Dashboard and Analytics pages from the reference screens, charts in general, the store pages, the bottom status bar, the breadcrumb path, and keyboard hint chips.
- **Owed to the future chart spec** (recorded now so it is not lost): main series `#7DD3FC` (bars may use `linear-gradient(180deg, #7DD3FC, #B4C6D8)`), comparison series `#64748B` (3.77 on a dark card, passes); parcel outcomes in the fixed order Delivered `#7EE0B0`, Refused `#64748B`, Failed `#FF8A8A`, Returned `#364252`. The Returned colour measures 1.76:1 on the dark card and the light comparison colour `#94A3B8` measures 2.56:1 on a white card, both below the 3:1 a chart mark needs, so that chart spec must pick other values or add a legend and a table view for them. This spec does not use chart colours.

### Docs that go false

Lines this change makes false. M1 fixes them (the first group is the brief's list, the second is what I found by search):

- `packages/ui/AGENTS.md` line 5 (overview names Daftar, warm paper, indigo, Inter, JetBrains Mono) and line 22 (`DESIGN.md` described as "direction B, Daftar").
- `apps/web/AGENTS.md` line 21 (fonts: Inter, Noto Sans Arabic, JetBrains Mono).
- `apps/web/src/shell/fonts/README.md` (the whole table and the notes about Inter and JetBrains Mono).
- `packages/ui/DESIGN.md` look sections (front matter, the opening paragraph, Color roles, Type, Spacing radius density where it names radius, Focus colour, Motion, Elevation, Components look, Brand accent).
- `packages/ui/README.md` line 9 ("Tokens (Daftar: ...)"), `apps/web/src/design/README.md` line 3 (the type specimens), `apps/web/src/shell/README.md` line 15 (names the fonts; check the line), `docs/scope/foundations.md` lines 48 and 54 (the Daftar wording is history; add a pointer to this spec when it is built, by `/sync` or the scope owner).
- Code comments and tests that name the old look: `packages/ui/src/lib/row-stripe.ts` line 7 (Daftar), `packages/ui/src/lib/brand-tokens.ts` line 5 (the near black brand foreground was the Daftar `--foreground`; with the new `foreground` it is `#0A0E14`, which changes the brand worked example in `packages/ui/DESIGN.md`: yellow `#F2C230` was 10.35 and is 11.54 with the new near black; the mid luminance window narrows, so the old refused examples `#A9780B` and `#808080` now pass and are replaced by `#997311` (4.43, refused) and `#797979` (4.44, refused)), `packages/ui/src/components/ltr-text.tsx` line 7 (JetBrains Mono), `apps/web/src/design/design-gallery.tsx` lines 46 and 131, `apps/web/src/shell/static-root-frame.spec.tsx` line 32 (the font class names), `apps/web/e2e/shell.spec.ts` line 459 and `production.spec.ts` line 88 (the `Inter` family), `apps/web/e2e/design-contrast.spec.ts` lines 5, 162 and 258 (Daftar pairs, JetBrains Mono).
- [spec 0003](../0003-design-system-ui-foundation/index.md) itself: amended by this spec in the same change (its Status line and a note under the Daftar amendment). Its option previews in `directions/` are history and stay.

### Light theme approval

- **Date**: 2026-11-14.
- **Approved by**: the owner, on `/design`.
- **Changed value**: one. Light `accent` `#DCE5EE` becomes `#E9EEF4` (option B). Measured live on `/design` on `#E9EEF4`: `foreground` 16.58, `muted-foreground` 6.45, `primary` 4.59, confirmed 4.70, owed 4.65, failed 4.99, all pass 4.5.
- **Everything else**: approved as shown, including row hover staying the `tint-row` utility in both themes.
- **Commit holding the values**: to be filled in when the change is committed.

## Build plan

The project builds by Tracer Bullet ([AGENTS.md](../../../AGENTS.md)): prove one thread through every layer, then thicken one segment at a time. Here the thread is the design system itself plus one real screen sample in M1 (`/design`), then screen batches in order, each batch end to end (restyle, both themes, both directions, axe, keyboard). One commit per milestone, as the project's git rule says. All milestones are owned by **frontend** (the design system and web app); no backend or devops work is needed, and the api, schema, and contracts do not change.

### M1. Design system: tokens, components, fonts, `/design`

Owner: frontend (ui designer for `DESIGN.md` and the look, frontend developer for the font files and the tests).

- Tokens, new roles, gradient and motion utilities, radius tokens, and the reduced motion rule in `packages/ui/src/styles/globals.css`.
- Base components restyled in `packages/ui/src/components/` and the look in `src/status/`, `src/frames/`, `src/dashboard/`, `src/help/` where they hard code the old look.
- `packages/ui/DESIGN.md` look sections rewritten (behaviour and rule sections kept) with the measured contrast table.
- Fonts swapped: Geist and Geist Mono files and licences added, Inter and JetBrains Mono files and licences removed, `root-fonts.ts` and the fonts README updated, no new dependency.
- `/design` shows the palette, the gradients, and every pair measured live including gradient stops, for the dark and the light theme.
- Docs from [Docs that go false](#docs-that-go-false) updated.
- **Done when**: AC-1 to AC-5, AC-6 to AC-16, AC-18 to AC-20, and AC-23 hold on `/design`; axe reports zero violations on `/` and `/design` in dark and light, English and Arabic (left to right and right to left); `pnpm lint`, `pnpm typecheck`, `pnpm test` pass; and the owner has approved the light theme on `/design` (AC-17, written under Light theme approval). M2 does not start before that.

### M2. Shell and the five sign in screens

Owner: frontend.

- The app shell (sidebar, top bar, location switcher, command palette, user menu) and the five `(auth)` screens in the new look.
- **Done when**: both are restyled with role tokens only; the current page marker, the `//` labels where a section label exists, and the focus ring match the tables; `shell.spec.ts` geometry passes unchanged (AC-20); axe zero in the four theme and direction combinations (AC-22); keyboard flows of spec 0003 AC-4 still pass.

### M3. Orders: list, order page, new order

Owner: frontend.

- The orders list (table with lowercase mono headers, selected and hover row tints, chips with glow), the order page, and the new order form.
- **Done when**: the column order is unchanged (code, who, where, how much, state, cash); the list renders at most three chips per row with the overflow count as before; AC-21 and AC-22 hold on all three screens; the existing orders unit and Playwright specs pass with only look assertions changed.

### M4. Stock and the product catalogue

Owner: frontend.

- Stock, stock receipts (three screens), SKUs (two), styles (two), product groups, seasons, and locations.
- Owner ruling (2026-11-14): the online stock warning notice is a needs-attention warning, so it uses the `Alert` `warning` variant (amber border and text, triangle), not the info look (AC-10, decision 13).
- Owner ruling (2026-11-14): table rows that hold a button stay 40px (cells drop vertical padding, the 32px `sm` button is not shrunk); a row with the in-use note under its action on `/seasons` and `/product-groups` grows to fit it, about 52px in English and about 60px in Arabic, when the note fits on one line; in a narrow table the note wraps (it is never cut or hidden behind a sideways scroll) and the row grows to fit, up to about 82px in Arabic, and so does a style page SKU row with a two line cost cell, 58 to 63px (AC-20, decision 14).
- **Done when**: all of them are restyled; forms use the field look (AC-8), and the segmented control look (AC-9) if a form needs one and it is vendored then; AC-21 and AC-22 hold; no screen's data or actions changed.

### M5. Customers and connections

Owner: frontend.

- Customers list, profile, merge, and the two connections screens.
- Owner ruling (2026-11-16): merge suggestion rows on `/customers` (review tab) grow to fit the two line customer cell (name with phone below) beside the Merge and Dismiss buttons, with no layout change (measured at 1280px: about 48 to 73px in English, about 59px in Arabic), recorded next to the style page two line cost cell exception; connection rows on `/connections` that show a health reason or warning sentence grow to fit it like the in-use note rows, and that text is never truncated or hidden behind a sideways scroll (about 77 to 80px); rows without a sentence stay 40px (AC-20, decision 14).
- **Done when**: restyled; the profile timeline and the returner signal look the same in behaviour; provisional values keep their dashed boundary, `≈`, and hidden label on the new colours; AC-21 and AC-22 hold.

### M6. Home, staff, audit, settings, cost rules, account

Owner: frontend.

- Home, staff, audit, settings, cost rules, and account.
- Owner ruling (2026-11-19): the setting change consequence messages (`entry.warning` in the setting change dialog and the step on dialog: time zone, prices include VAT, sales tax rate, operating day cutoff, store product group, Shopify stock safety buffer) are needs-attention warnings, so they use the `Alert` `warning` variant with the triangle icon; "It stays waiting until its work is running again" and "Nothing is locked yet, so a rule can start on any day" stay info notices (`muted-foreground`, "i" icon); wording unchanged (AC-10, decision 13).
- Owner ruling (2026-11-19): `/audit` list rows grow to fit the two line Record cell (record type over its number), about 55px in English and about 59px in Arabic at 1280px, and `/staff` rows on the people and partner logins tabs in Arabic, where the table cannot hold the name, the email, and the last sign in date (kept on one line, `whitespace-nowrap`) on one line, grow to fit a wrapped name or email cell, about 56 to 57px at 1280px, with Arabic rows whose cells fit and every English row staying 40px; no layout change, and the text is never truncated or hidden behind a sideways scroll, recorded next to the M5 merge suggestion row exception (AC-20, decision 14).
- **Done when**: restyled; info notices use `muted-foreground` with the "i" icon (AC-10); AC-21 and AC-22 hold.

### M7. Portal and partner surfaces

Owner: frontend.

- Portal returns screens and their previews, the partner pages and their preview.
- Owner ruling (2026-11-19): `PortalFrame` and `PartnerFrame` stay flat on `bg-background`, with no glow and no grid backdrop. The cyan glow and grid stay on the sign in screens only, so they never compete with a brand's own accent on the portal. The partner bar sits on the page fill like the staff top bar, and its current link gets the current page tint and a 2px cyan mark at its bottom edge. The main portal button is `<Button variant="brand">`: the brand fill with the lift, no primary blend and no sheen.
- **Done when**: restyled inside `PortalFrame` and `PartnerFrame`; the brand accent still colours only the logo tile, the top rule, and the main portal button (spec 0003 AC-19), and the brand fallback is the new `primary`; one Arabic weight pair loads first in the portal and the portal makes no request to a font host (spec 0003 AC-23, AC-14 here); AC-21 and AC-22 hold at the portal's 320px baseline.

## Consequences

- One look across the product, with a real light theme and a dark theme that is the owner's design exactly.
- A migration risk is small: token values, a font swap, and class changes in base components; no structure, route, or data changes.
- Several tests name the old look (a font family, a Daftar pair, a class list) and change in the same milestones; only look assertions may change (AC-21).
- Gradient text on `h1` is a known weak spot for contrast checkers: axe may report the gradient text as "incomplete" rather than passing it. The stop by stop measurement and the plain `foreground` fallback are the mitigation; M1 runs axe on a heading and records what it says.
- Row hover is the `tint-row` utility in both themes, not `accent` (AC-5). Text on `accent` is no longer restricted (every pair passes), but the hover tint rule still holds.

## Follow-up

- The chart colours that fail 3:1 (Returned `#364252` on dark, light comparison `#94A3B8`) go to the future chart spec.
- The Dashboard and Analytics pages from the reference screens are a separate feature and need their own spec.
- `docs/scope/foundations.md` should point at this spec when it is built (`/sync`).
- If Geist has no `tnum` feature, numeric columns use Geist Mono (AC-16).

## Rationale

Reasoning, the alternatives considered, and the sources: see [rationale.md](rationale.md).
