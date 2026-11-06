---
source: spec 0003, option B Daftar (chosen by the owner; no external design)
tokens: packages/ui/src/styles/globals.css
gallery: /design (development only)
---

# SSDashboard design system

Direction B, "Daftar" (a daftar is a ledger notebook): the look of a well kept paper ledger, built for long days of tables, forms, and scan screens. Warm off white paper, one deep indigo for the main action, soft tinted status chips, Inter for English and Noto Sans Arabic for Arabic, JetBrains Mono for codes, 8px corners. Hue appears only where it means something (confirmed, failed, owed, provisional, info) and in the one primary action. Chosen by the owner in spec 0003; the unchosen directions (Quiet Ledger, Floor Console) stay in the spec.

Token values live in [`src/styles/globals.css`](src/styles/globals.css). This file holds the rules for using them. The live versions of everything here, with measured contrast, are on `/design` in development.

## Build mandate

- Use role tokens only (`bg-background`, `text-muted-foreground`, `border-input`). No raw hex, rgb, oklch, or Tailwind palette classes (`bg-zinc-200`) in components or pages.
- Use logical sides only: `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `border-s`/`border-e`, `rounded-s`/`rounded-e`, `text-start`/`text-end`. `pnpm lint` fails on physical ones (`check-logical-css.mjs`).
- No text inside `packages/ui`. Every label, including screen reader only ones, arrives as a prop. Apps pass text through `t()`.
- Every staff page renders inside the app shell, and every page has exactly one `<h1>`; the sign in screens and the public portal and partner seams use a minimal frame instead.
- Every interactive control works from the keyboard, shows the focus ring, and has an accessible name.

## Color roles

Light values are in `:root`, dark values in `.dark`. Modes are Light, Dark, and System (the default), chosen in the user menu. Both modes are warm: neutrals sit at hue 70 to 85 (paper and ink), the primary at hue 275 (indigo), so the page never reads cold or gray.

| Role                                                          | Light                  | Dark                   | Used for                                                                                              |
| ------------------------------------------------------------- | ---------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `background`                                                  | `0.985 0.006 85`       | `0.19 0.012 70`        | The page (paper)                                                                                      |
| `foreground`                                                  | `0.22 0.02 70`         | `0.96 0.01 85`         | Text (ink)                                                                                            |
| `card`, `popover`                                             | `0.997 0.003 85`       | `0.23 0.014 70`        | Raised surfaces: cards, menus, dialogs, sheets. `card-foreground` and `popover-foreground` equal `foreground` |
| `primary` (+ `-foreground`)                                   | `0.38 0.12 275` / `0.99 0.003 85` | `0.78 0.12 280` / `0.2 0.03 275` | The one main action in a view, links, selected state |
| `secondary`, `muted`                                          | `0.955 0.01 85`        | `0.28 0.014 70`        | Quiet fills: secondary buttons, table header, chips of no meaning. `secondary-foreground` equals `foreground` |
| `accent`                                                      | `0.935 0.014 85`       | `0.32 0.016 70`        | Hover and selected rows and menu items (a step darker than `muted`). `accent-foreground` equals `foreground` |
| `muted-foreground`                                            | `0.46 0.02 70`         | `0.75 0.02 80`         | Secondary text, placeholders, captions                                                                |
| `border`                                                      | `0.9 0.012 85`         | `0.33 0.014 70`        | Decorative separators and card edges only (exempt from 3:1)                                           |
| `input`                                                       | `0.58 0.02 70`         | `0.6 0.02 75`          | The boundary of anything you can operate: fields, outline buttons, checkboxes, the dashed provisional boundary |
| `ring`                                                        | the `primary`          | the `primary`          | The focus ring (indigo in both modes)                                                                 |
| `success`                                                     | `0.45 0.11 150`        | `0.78 0.15 150`        | Meaning only (see the four roles below)                                                               |
| `warning`                                                     | `0.48 0.11 65`         | `0.82 0.14 80`         | Meaning only                                                                                          |
| `destructive`                                                 | `0.5 0.19 27`          | `0.74 0.16 25`         | Errors, deletes, failed delivery                                                                      |
| `info`                                                        | `0.45 0.07 235`        | `0.78 0.08 235`        | Notices. A quiet slate, so it cannot be mistaken for the indigo primary                               |
| `success-`, `warning-`, `destructive-`, `info-` `foreground`  | `0.99 0.003 85`        | `0.19 0.012 70`        | Text on a solid fill of that hue (the paper color in light, the page color in dark)                   |
| `sidebar`                                                     | `0.972 0.008 85`       | `0.21 0.013 70`        | The app shell sidebar. `sidebar-primary`, `-ring` equal `primary`; `sidebar-border` equals `border`; `sidebar-accent` is `0.93 0.014 85` light, `0.3 0.016 70` dark |
| `brand`, `brand-foreground`                                   | `primary` / `primary-foreground` | the same      | Portal accent (AC-19), see below                                                                      |

All values are `oklch(L C H)`. `border` is solid in both modes. Hue never decorates: nothing outside the roles above and the portal brand tile uses a colored fill.

Keep one filled `primary` button per view. Hierarchy comes from fill versus outline, weight, and placement; the indigo is rare on purpose so the main action is the first thing a tired eye finds.

### Four meaning roles (AC-16)

Order and cash state is shown by four roles, each an alias of an existing hue so no hue is added. They are defined in both `:root` and `.dark` and mapped in Tailwind as `text-confirmed`, `bg-confirmed-surface`, and so on.

| Role | Alias of | Means | Icon | Chip surface |
|---|---|---|---|---|
| `confirmed` | `success` | Confirmed (cash received, order confirmed) | check | `confirmed-surface` |
| `failed` | `destructive` | Failed delivery | cross | `failed-surface` |
| `owed` | `warning` | Cash owed (always name who owes: Bosta, a partner, a customer) | coin | `owed-surface` |
| `provisional` | `muted-foreground` | Not yet confirmed | dashed clock | `provisional-surface` (transparent) |

- A chip surface is the hue at 12 percent mixed into `card` (`color-mix(in oklab, var(--confirmed) 12%, var(--card))`), with the hue as the text color. `info-surface` is built the same way for notices; info never carries order state.
- A `StatusChip` always shows an icon and a word together. Color is never the only carrier of meaning. One row shows at most three chips (fulfillment, cash, attention); the rest sit behind a count ("+2"). Row order: code, who, where, how much, state, cash.
- Chips are 4px corners (`rounded-sm`, 4.8px) and `text-xs font-medium`.
- A brand accent never colors any of these (AC-19), so a brand whose accent is green cannot be confused with "confirmed".

### Provisional values (AC-17)

- A provisional number is drawn with a leading `≈` (inside a `bdi`, so it stays first in right to left), a **dashed** boundary (`border-dashed border-input` on a `provisional-surface` that is transparent, never a solid fill or solid border), and a visually hidden "provisional" label. Confirmed values are plain.
- A total that mixes both shows the confirmed part and the provisional part separately. A provisional dashboard card is a dashed card.
- The provisional text is `muted-foreground`; its boundary is `input`, the control boundary, so the dash itself meets 3:1.
- Every dashboard and report view that shows provisional data carries a freshness strip: "Confirmed through <operating day>, today is provisional".

### Brand accent (AC-19)

`--brand` and `--brand-foreground` default to `--primary` and `--primary-foreground`. The portal frame overrides them inline from settings after `deriveBrandTokens` accepts the accent (at least 4.5:1). Use `bg-brand text-brand-foreground` only for the logo tile, a 6px top rule, and the main portal button. Never for status, text, the focus ring, or a chip.

### Measured contrast

Text needs 4.5:1 (3:1 for large text). Control boundaries and the focus ring need 3:1 against what sits next to them. Measured from the token values with a throwaway script (oklch to sRGB, clamped, WCAG 2 relative luminance; chip surfaces are the oklab mix of 12 percent hue and 88 percent `card`). The script was first run against the spec's option B figures and reproduced them (foreground on background 16.61 light and 16.45 dark, muted-foreground 6.85 and 8.30, success 6.77 and 9.78, chips 5.80 and 7.27) before any derived value was trusted. No lightness was nudged from the spec's proposal; the roles the spec did not list were derived once and all pass. `/design` measures them again live in the browser.

| Pair | Light | Dark | Needs |
|---|---|---|---|
| foreground on background | 16.61 | 16.45 | 4.5 |
| foreground on card (also `card-foreground`, `popover-foreground`) | 17.20 | 15.06 | 4.5 |
| foreground on muted (also `secondary-foreground`) | 15.22 | 13.01 | 4.5 |
| foreground on accent | 14.33 | 11.32 | 4.5 |
| muted-foreground on background | 6.85 | 8.30 | 4.5 |
| muted-foreground on card | 7.09 | 7.59 | 4.5 |
| muted-foreground on muted | 6.27 | 6.56 | 4.5 |
| muted-foreground on accent | 5.91 | 5.71 | 4.5 |
| muted-foreground on sidebar | 6.59 | 7.96 | 4.5 |
| primary-foreground on primary | 10.05 | 8.82 | 4.5 |
| primary on background (links) | 9.91 | 8.99 | 4.5 |
| primary on card | 10.26 | 8.22 | 4.5 |
| success on background / card | 6.77 / 7.01 | 9.78 / 8.95 | 4.5 |
| warning on background / card | 6.45 / 6.68 | 10.45 / 9.56 | 4.5 |
| destructive on background / card | 6.34 / 6.57 | 7.46 / 6.83 | 4.5 |
| info on background / card | 7.02 / 7.27 | 9.37 / 8.58 | 4.5 |
| success-foreground on success | 6.87 | 9.78 | 4.5 |
| warning-foreground on warning | 6.54 | 10.45 | 4.5 |
| destructive-foreground on destructive | 6.44 | 7.46 | 4.5 |
| info-foreground on info | 7.12 | 9.37 | 4.5 |
| confirmed on confirmed-surface (chip) | 5.80 | 7.27 | 4.5 |
| owed on owed-surface (chip) | 5.55 | 7.71 | 4.5 |
| failed on failed-surface (chip) | 5.47 | 5.73 | 4.5 |
| info on info-surface (chip) | 6.00 | 7.01 | 4.5 |
| provisional text on card / background | 7.09 / 6.85 | 7.59 / 8.30 | 4.5 |
| brand-foreground on brand (default, the primary pair) | 10.05 | 8.82 | 4.5 |
| sidebar-foreground on sidebar | 16.00 | 15.79 | 4.5 |
| sidebar-primary-foreground on sidebar-primary | 10.05 | 8.82 | 4.5 |
| sidebar-accent-foreground on sidebar-accent | 14.11 | 12.16 | 4.5 |
| input on background | 4.11 | 4.67 | 3 |
| input on card / popover (also the dashed provisional boundary on its transparent surface over a card) | 4.26 | 4.28 | 3 |
| input on muted | 3.77 | 3.70 | 3 |
| input on sidebar | 3.96 | 4.48 | 3 |
| ring on background | 9.91 | 8.99 | 3 |
| ring on card | 10.26 | 8.22 | 3 |
| ring on muted | 9.08 | 7.11 | 3 |
| ring on sidebar | 9.54 | 8.62 | 3 |

Weakest text pair: failed on its chip (5.47 light, 5.73 dark). Weakest boundary: input on muted in dark (3.70). A brand accent that replaces `brand` is checked by `deriveBrandTokens`, not by this table.

Disabled controls are exempt from contrast but stay at 3:1 or more, so a disabled "No locations yet" is still readable.

## Type

Fonts: Inter (Latin), Noto Sans Arabic (Arabic), JetBrains Mono (codes). All SIL OFL 1.1, self hosted by the app (`next/font`, variables `--font-inter`, `--font-noto-arabic`, `--font-jetbrains-mono` on `<html>` from `apps/web/src/shell/root-fonts.ts`), never from a font host at runtime. Tailwind maps them: `font-sans` and `font-heading` are Inter; `font-arabic` is Noto Sans Arabic then Inter; `font-mono` is JetBrains Mono.

| Step | Utility | Latin size / line | Arabic size / line | Weight |
|---|---|---|---|---|
| Page title (`h1`) | `text-xl font-semibold` | 20px / 28px | 21px / 1.7 | 600 |
| Section title (`h2`) | `text-base font-semibold` | 17px / 25.5px | 18px / 1.7 | 600 |
| Body, the default | `text-sm` | 15px / 22.5px | 16px / 1.75 | 400 |
| Labels, emphasis | `text-sm font-medium` | 15px / 22.5px | 16px / 1.75 | 500 |
| Secondary, captions, chips | `text-xs` (captions add `text-muted-foreground`) | 12px / 16px | 13px / 1.75 | 400 |

- Weights 400, 500, and 600 only.
- **How 15px body is expressed (AC-23).** Components keep their classes (`text-sm`, `text-base`); the tokens change instead. `globals.css` retunes `--text-sm` to 0.9375rem and `--text-base` to 1.0625rem, and `body` stays `text-sm`. So every shadcn control and table cell that says `text-sm` is 15px with no component edit. `text-xs` (12px) and `text-xl` (20px) keep Tailwind's defaults. Never write `text-[15px]`.
- **Arabic rule.** Anything under `lang="ar"` (the `:lang(ar)` base rule) switches to `font-arabic` and overrides the same size and line height variables: each step is one pixel larger than the Latin step beside it (body 16px beside 15px, `xs` 13px, section 18px, page title 21px), and the line height is at least 1.7 at every step (body and captions 1.75). Noto Sans Arabic has a smaller optical size than Inter at the same pixel size, hence the extra pixel. The first look at it beside Inter in a table row is owed by the visual check of task 1.1 (`/design`); tune the `:lang(ar)` sizes there, not in components.
- Numbers in columns, totals, and quantities use `tabular-nums` (Inter has tabular figures). Digits are Western in both languages, formatted by the app.
- Every code that must read left to right (SKU, barcode, document number, email, URL, version such as `0.0.0-dev`) sits in `LtrText` (`@ssdashboard/ui/components/ltr-text`), never bare text, so right to left pages keep its order. `LtrText` sets `font-mono` (JetBrains Mono), so codes read apart from names. It keeps the surrounding size; do not mix it into prose.

## Spacing, radius, density

- Spacing follows Tailwind's 4px scale. Use `gap-*` for layout, not margins between siblings.
- Radius is `--radius: 0.5rem` (8px): `rounded-lg` (8px) for cards and dialogs, `rounded-md` (6.4px, read as 6px) for buttons and controls, `rounded-sm` (4.8px, read as 4px) for chips and items inside menus, `rounded-xl` (11.2px) rarely. The preview draws cards 8px, buttons 6px, chips 4px; the 0.6 and 0.8 multipliers land within a pixel of it.
- Density is compact for data and normal for forms; there is no density toggle. One scope, `floor`, raises it for the hands on a touch screen (below).

| Element | Utility | Default | `floor` on a coarse pointer |
|---|---|---|---|
| Table row | `h-row` (`--spacing-row`) | 40px | 48px |
| Table header | `h-row-header` | 44px | 52px |
| Form control | `h-control` | 40px | 48px |
| Focus ring width | `--focus-width` | 2px | 3px |
| Sidebar item (fine pointer) | `h-nav-item` | 32px | unchanged |
| Shell top bar | `h-topbar` | 56px | unchanged |
| Touch target | `h-touch` / `size-touch` | 44px | unchanged |

About 20 table rows fit a 1080p screen at 40px.

### The `floor` scope (AC-22)

`floor` is for people who tap and scan all day on a tablet or handheld, not for the operations lead's long tables.

- Put `data-density="floor"` on the container of the confirmation queue and of every scan screen. In `globals.css`, `[data-density='floor']` inside `@media (pointer: coarse)` sets `--spacing-row` 3rem, `--spacing-row-header` 3.25rem, `--spacing-control` 3rem, and `--focus-width` 3px. Everything inside that uses `h-row`, `h-control`, `focus-ring` follows with no class change.
- On a fine pointer (mouse) the scope does nothing: the queue keeps 40px controls there. The scan screens add their own large outcome buttons, at least 48 by 48.
- One outcome per button, with its shortcut visible on the button. On phones the action bar is sticky at the bottom.
- Not for: the order tables, settings, and reports. Do not set it on the page shell.

## Focus, targets, motion, elevation

- **Focus**: `focus-visible` only, the same everywhere: an indigo `ring` outline of `--focus-width` (2px, 3px in `floor`) with a 2px gap (`focus-ring`, and the base `:focus-visible` rule). Items inside clipped lists (menu items) use `focus-ring-inset`, which draws the ring inside by the same width. The ring is 3:1 or better on every surface (table above). Never remove an outline without replacing it.
- **Targets**: every interactive target is at least 24 by 24px. On touch screens (`coarse:` variant, `pointer: coarse`), shell controls and menu, sheet, and command items are at least 44 by 44px; `floor` controls are 48px.
- **Motion**: the shadcn defaults (150 to 200ms fades, zooms, and slides), all switched off under `prefers-reduced-motion: reduce`.
- **Elevation**: flat by default. Popovers and menus use `shadow-md` plus a hairline ring; dialogs and sheets `shadow-lg` over a dimmed overlay. No shadows on cards inside pages; cards are `card` on `background` with a `border` hairline.

## Icons

- Lucide (`lucide-react`). Size them through the component (`data-icon="inline-start"` in buttons), not with size classes.
- Decorative icons get `aria-hidden`. An icon only button gets an accessible name (`aria-label` or `sr-only` text).
- **Directional icons mirror in right to left** with `rtl:-scale-x-100`: chevrons (`ChevronLeft`, `ChevronRight`, `ChevronsLeft`, `ChevronsRight`), arrows that point along the line (`ArrowLeft`, `ArrowRight`, `ArrowLeftToLine`, `ArrowRightToLine`, `Undo`, `Redo`), back and forward, `PanelLeft`/`PanelRight`, `LogOut`/`LogIn`, `ListIndent`/`ListOutdent`, and send or reply icons.
- **Never mirror** icons that do not point along the line: search, user, box, map pin, check, warning, up and down arrows and chevrons, `ArrowLeftRight`, clocks, and brand marks.

## Components

### App shell

- Every page renders in `AppShell`: the sidebar, a top bar (`<header>`), and the single `<main id="main-content">`.
- The skip link is the first focusable element and jumps to `#main-content`.
- Sidebar entries come from the typed registry in `apps/web/src/shell/nav.ts`, grouped by module. A group with no visible entries is not rendered. The current page gets `aria-current="page"` (exact match for `/`, prefix match for others).
- 768px and up: the sidebar collapses to an icon rail (Ctrl+B or Cmd+B, or the toggle), and the state persists in the `sidebar_state` cookie. Below 768px it is a sheet from the start edge, opened by the menu button and closed when you pick a page.
- The top bar holds, in order: menu button (phones), sidebar toggle, client name, location switcher, command palette button, user menu.
- The command palette (Ctrl+K or Cmd+K, from anywhere) lists the registry. Later features register more groups. Esc closes it and focus goes back where it was.
- The location switcher is the source of `useCurrentLocation()`. Stock screens default to it; they never read the cookie themselves.

### Data tables (built by features 7 and 8)

- Build on TanStack Table with the shadcn `Table` parts. Rows are `h-row` (40px; 48px in the `floor` scope on touch), the header `h-row-header` (44px; 52px) on `bg-muted` with `font-medium` labels.
- Numbers, quantities, and money are end aligned (`text-end`) with `tabular-nums`. Text columns are start aligned.
- Row hover is `hover:bg-muted`; a selected row is `bg-accent` plus a checked row checkbox. Never color alone. Status in a row is a `StatusChip` (icon plus word, at most three, then a "+2" count), in the column order code, who, where, how much, state, cash; provisional amounts follow the provisional rules above.
- **Chips in a row.** At most three `StatusChip`s per row: fulfillment, cash, and one more. Attention (a flag, a note, a problem) is a small flag under the name, not a chip. Anything beyond three collapses into a `StatusChipOverflow` "+N" (a button listing the rest when the row has room for one, otherwise plain text); never hide a failed or owed status only behind the count.
- **Column order is fixed**: code, who, where, how much, state, cash. Money and counts end aligned with `tabular-nums`; the state and cash columns hold the chips.
- **Provisional in a table.** A provisional amount is a `ProvisionalValue`: `≈` first (inside a `bdi`, so it stays first in right to left), a dashed `input` boundary on a transparent surface (never solid), `tabular-nums`, and a hidden "provisional" label. A total that mixes both shows the confirmed part and the provisional part as two separate values, never one blended sum. A provisional dashboard card is a dashed card (`border-dashed border-input`).
- **Cash owed always names who owes** (Bosta, a partner, a customer): the `owed` chip label or the cell beside it carries the name, never a bare "Owed".
- **Freshness strip.** Every dashboard and report header is followed by a `FreshnessStrip` ("Confirmed through 4 Nov, today is provisional"), composed and translated by the caller.
- **Row start stripe** (`rowStripeClassName(meaning)`) is decorative only and off by default in option B: the chip already says the meaning. If a screen uses it, it sits on the first cell or a wrapper, and the chip stays.
- **Where they live.** Outside `src/components/` (ADR 0001), one per file: `@ssdashboard/ui/status/status-chip` (`StatusChip`, `{ meaning, label, className }`), `.../status/status-chip-overflow` (`StatusChipOverflow`, `{ count, label, onClick?, className }`), `.../status/provisional-value` (`ProvisionalValue`, `{ value, provisionalLabel, className }`), `.../status/freshness-strip` (`FreshnessStrip`, `{ text, className }`), `@ssdashboard/ui/lib/row-stripe` (`rowStripeClassName`), and `@ssdashboard/ui/lib/status-meaning` (the `StatusMeaning` type, `STATUS_MEANINGS`). Icons: check (confirmed), X (failed), coins (owed), clock fading (provisional; lucide has no dashed clock), all `aria-hidden`. A chip with a blank label renders nothing, so no chip is ever icon only. Chips are 24px (`h-6`), `rounded-sm`, `text-xs font-medium`; the provisional chip is transparent with a 1px dashed `border-input`.
- **Density tokens.** `Button` (default, `lg`, `icon`), `Input`, `TableRow` (`h-row`), and `TableHead` (`h-row-header`) take their heights from `h-control`, `h-row`, and `h-row-header`, so the `floor` scope reaches them. The default button is therefore 40px (was 36px); `sm`, `xs`, and sidebar items keep fixed sizes (32 and 24px, sidebar item `h-nav-item`), and shell controls still lift to 44px on touch with `coarse:min-h-touch`.
- Sortable headers are buttons with `aria-sort` on the `th`, and the sort icon is decorative.
- Keep the header row sticky in long tables. Wide tables scroll inside their container, never the page.
- Row actions sit in a trailing column as an icon button with a dropdown menu; the button's name includes the row ("Actions for TBL-OAK-120").
- DropdownMenu is non-modal by default (a modal menu aria-hides the shell and fails axe aria-hidden-focus); no scroll lock; one outside press closes the menu AND activates the pressed control. Keep this when re-copying from shadcn.
- States: loading shows skeleton rows at the real row height; empty uses the empty pattern below inside the table body; an error replaces the body with an inline alert and a retry.

### Forms (built by features 7 and 8)

- Use the shadcn `Field` parts: a visible label above every control (placeholders are hints, never labels), help text below in `text-xs text-muted-foreground`.
- Controls are `h-control` (40px; 48px in the `floor` scope on touch) with an `input` border.
- Validation: `aria-invalid` on the control and `data-invalid` on the field, a `destructive` message linked with `aria-describedby`, shown after blur or submit, never while typing. On submit with errors, focus the first invalid field.
- Required fields say so in the label text ("Required"), not only with an asterisk.
- Buttons: one primary submit at the end of the form, then secondary actions. A pending submit disables the button and shows a spinner with the same label.
- Group related controls with `FieldSet` and a `FieldLegend`. Choices of 2 to 7 options use a `ToggleGroup` or radio group.

### Feedback

- **Toast** (sonner): brief confirmations of something that already happened ("Transfer TR-000123 posted"). Polite live region, at least 5 seconds, never the only place an error appears.
- **Dialog**: confirms a destructive or hard to undo action. Title says what happens, the destructive button names the action ("Archive", never "OK"), and Cancel is a footer close button. Focus returns to the trigger.
- **Empty**: an icon, one sentence on what belongs here, and the action that adds the first item. "No locations yet" style, not "No data".
- **Loading**: skeletons in the shape of the content for lists and cards; a spinner only inside buttons. Announce long loads in a polite live region.
- **Error**: an inline `Alert` with the `destructive` role tokens, what failed in plain words, and a retry. Keep the rest of the page usable.

## Right to left

- `dir` on `<html>` drives layout; Radix reads its own `DirectionProvider`, so both always change together. Direction follows the language: Arabic is right to left, English left to right. The language switch (user menu, Language) changes `lang`, `dir`, and the Radix direction at once and saves the choice in the `ss_lang` cookie (spec 0004).
- Components take all text through props (labels, titles, `aria-label`, `placeholder`, `alt`); `lint` fails on a raw literal. Numbers, money, and dates are formatted by the app through its shared formatters (Western digits in both languages), never inside a component.
- Write layout once with logical sides; it mirrors on its own. Sheets and sidebars take `side="start" | "end"`.
- Tab order follows DOM order, so it mirrors with the layout.
