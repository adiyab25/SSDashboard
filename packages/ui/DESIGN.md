---
source: spec 0025, Midnight, Silver and Cyan (chosen by the owner; amends spec 0003)
tokens: packages/ui/src/styles/globals.css
gallery: /design (development only)
---

# SSDashboard design system

"Midnight, Silver and Cyan": a deep blue black page (`#0A0E14`), silver text, and one ice cyan (`#7DD3FC`) that means "link, focus, current page" and nothing else, built for long days of tables, forms, and scan screens. The main action of a view is a silver to cyan gradient button, the page heading carries a soft silver to cyan fill, section labels read like code comments (`// orders`), tables use lowercase mono headers, status chips glow, and everything moves with one easing curve. Geist and Geist Mono for Latin and codes, Noto Sans Arabic for Arabic, four named corner radii. Hue appears only where it means something (confirmed, failed, owed, provisional) and in the one main action. The dark theme is the owner's design exactly; the light theme is derived from the same roles. Chosen by the owner in spec 0025, which replaces the "Daftar" look of spec 0003; everything behavioural in spec 0003 stays, and density does not change.

Token values live in [`src/styles/globals.css`](src/styles/globals.css). This file holds the rules for using them. The live versions of everything here, with measured contrast, are on `/design` in development.

## Build mandate

- Use role tokens only (`bg-background`, `text-muted-foreground`, `border-input`). No raw hex, rgb, oklch, or Tailwind palette classes (`bg-zinc-200`) in components or pages.
- Use logical sides only: `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `border-s`/`border-e`, `rounded-s`/`rounded-e`, `text-start`/`text-end`. `pnpm lint` fails on physical ones (`check-logical-css.mjs`).
- No text inside `packages/ui`. Every label, including screen reader only ones, arrives as a prop. Apps pass text through `t()`.
- Every staff page renders inside the app shell, and every page has exactly one `<h1>`; the sign in screens and the public portal and partner seams use a minimal frame instead.
- Every interactive control works from the keyboard, shows the focus ring, and has an accessible name.

## Color roles

"Midnight, Silver and Cyan": a deep blue black page, silver text, and one ice cyan that means "link, focus, current page" and nothing else. Dark values live in `.dark`, light values in `:root` (derived from the same roles; the owner approves them on `/design`, spec 0025 AC-17). Modes are Light, Dark, and System (the default), chosen in the user menu. Alpha colours are written as eight digit hex (`#RRGGBBAA`) and painted over the surface they sit on.

| Role                                                | Dark                             | Light              | Used for                                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background`                                        | `#0A0E14`                        | `#F4F7FA`          | The page                                                                                                                                                                                  |
| `sidebar`                                           | `#0C1119`                        | `#EBF0F5`          | The app shell sidebar (chrome)                                                                                                                                                            |
| `card`                                              | `#111722`                        | `#FFFFFF`          | Cards, panels, tables. `card-foreground` equals `foreground`                                                                                                                              |
| `popover`                                           | `#18202C`                        | `#FFFFFF`          | Menus, popovers, dialogs, sheets. `popover-foreground` equals `foreground`                                                                                                                |
| `secondary`, `muted`                                | `#18202C`                        | `#EEF2F6`          | The control fill: secondary buttons, chips, the table header fill. `secondary-foreground` equals `foreground`                                                                             |
| `accent`                                            | `#243044`                        | `#E9EEF4`          | Hover and selected: menu focus, the selected segment. `accent-foreground` equals `foreground`. Carries text, links, and status in both themes (rule below) |
| `foreground`                                        | `#E6E8EB`                        | `#0A0E14`          | Text. `card-`, `popover-`, `sidebar-`, `secondary-`, `accent-` `foreground` equal it                                                                                                      |
| `muted-foreground`                                  | `#9AA6B8`                        | `#4A5568`          | Labels, captions, table headers, placeholders, info notices                                                                                                                               |
| `primary`, `ring`                                   | `#7DD3FC`                        | `#0E7490`          | Cyan alone: links, the focus ring, the current page, the main action. Never status                                                                                                        |
| `primary-foreground`                                | `#0A0E14`                        | `#FFFFFF`          | Text on solid cyan and on the main button blend                                                                                                                                           |
| `primary-edge`                                      | `#BFE6FB`                        | `#0B5568`          | The main button's edge (3:1 on the page and on a card)                                                                                                                                    |
| `border`                                            | `#FFFFFF14`                      | `#0A0E1414`        | Decorative hairlines and card edges only (exempt from 3:1)                                                                                                                                |
| `border-strong`                                     | `#FFFFFF1F`                      | `#0A0E141F`        | The chip border and the table header rule                                                                                                                                                 |
| `input`                                             | `#5F7088`                        | `#6B7A90`          | The boundary of anything you can operate: fields, secondary button edge end, checkboxes, the dashed provisional boundary (3:1)                                                            |
| `success`                                           | `#7EE0B0`                        | `#047857`          | Confirmed (meaning only)                                                                                                                                                                  |
| `warning`                                           | `#E8B86D`                        | `#9A5B0B`          | Owed on status chips, and needs attention on notices (the Alert `warning` variant; the online stock warning is the first)                                                                                                                                                                       |
| `destructive`                                       | `#FF8A8A`                        | `#C02A2A`          | Errors, deletes, failed delivery                                                                                                                                                          |
| `destructive-surface`                               | `#2A1A1C`                        | `#FDECEC`          | The error toast and the error block fill                                                                                                                                                  |
| `success-`, `warning-`, `destructive-` `foreground` | `#0A0E14`                        | `#FFFFFF`          | Text on a solid fill of that hue                                                                                                                                                          |
| `info`                                              | `muted-foreground`               | `muted-foreground` | Notices that are not errors. A quiet grey with an "i" icon, **never cyan**, so it cannot be mistaken for a link. A needs-attention warning is the exception: it uses the Alert `warning` variant (amber border and text, triangle icon). `info-surface` is `muted`; `info-foreground` is `#0A0E14` dark, `#FFFFFF` light              |
| `sidebar-primary`, `-ring`                          | `primary`                        | `primary`          | `sidebar-primary-foreground` equals `primary-foreground`; `sidebar-accent` equals `accent`; `sidebar-border` equals `border`                                                              |
| `brand`, `brand-foreground`                         | `primary` / `primary-foreground` | the same           | Portal accent (AC-19), see below                                                                                                                                                          |

The values in `globals.css` are checked against this table by `src/styles/tokens.spec.ts`. No colour is `oklch` any more. Hue never decorates: nothing outside the roles above and the portal brand tile uses a coloured fill.

Keep one main button (the silver to cyan blend) per view. Hierarchy comes from fill versus outline, weight, and placement; the blend is rare on purpose so the main action is the first thing a tired eye finds.

**Rules that follow from the numbers.**

- **Cyan means three things and the main action.** `primary` and `ring` carry links, focus, the current page, the main action, and the selected row tint. Status never uses them (a Vitest spec asserts no `StatusChip` class holds `primary`, `ring`, a blend, or a gradient).
- **`accent` carries `foreground`, `muted-foreground`, links, and status text in both themes.** In light `#E9EEF4` measures foreground 16.58, muted-foreground 6.45, cyan link 4.59, confirmed 4.70, owed 4.65, failed 4.99, all at least 4.5. Row hover stays the alpha tint utility `tint-row` in both themes and does not derive from `accent`. Owner decision 2026-11-14: option B, light `accent` `#E9EEF4` (it replaces `#DCE5EE`, where cyan, confirmed and owed failed at 4.21 to 4.31).
- **The cyan marker is a mark, not text.** On the light current page tint the cyan as text is 3.88 and is not used; the current page text is `foreground` and the cyan is only the 2px marker (non text mark, 3:1, it has 4.67 on the light sidebar).

### Four meaning roles (AC-16)

Order and cash state is shown by four roles, each an alias of an existing role so no hue is added. They are defined in both `:root` and `.dark` and mapped in Tailwind as `text-confirmed`, `bg-confirmed-surface`, and so on.

| Role          | Alias of           | Means                                                          | Icon         | Chip surface                           |
| ------------- | ------------------ | -------------------------------------------------------------- | ------------ | -------------------------------------- |
| `confirmed`   | `success`          | Confirmed (cash received, order confirmed)                     | check        | `confirmed-surface` (the control fill) |
| `failed`      | `destructive`      | Failed delivery                                                | cross        | `failed-surface` (the control fill)    |
| `owed`        | `warning`          | Cash owed (always name who owes: Bosta, a partner, a customer) | coin         | `owed-surface` (the control fill)      |
| `provisional` | `muted-foreground` | Not yet confirmed                                              | fading clock | `provisional-surface` (transparent)    |

- **Chip look (spec 0025, AC-6).** A `StatusChip` is the control fill with a 1px `border-strong`, mono 12px lowercase text in the meaning colour, 24px tall (`h-6`), 6px corners (`rounded-chip`). It keeps its distinct icon per meaning and **the icon carries the glow**: `drop-shadow(0 0 8px <meaning colour>)`. No plain dot: a dot is the same shape for every meaning, so colour would be the only carrier. The provisional chip is transparent with a 1px dashed `input` border. A blank label still renders nothing.
- A `StatusChip` always shows an icon and a word together. Color is never the only carrier of meaning. One row shows at most three chips (fulfillment, cash, attention); the rest sit behind a count ("+2"). Row order: code, who, where, how much, state, cash.
- A brand accent never colors any of these (AC-19), so a brand whose accent is green cannot be confused with "confirmed".

### Provisional values (AC-17)

- A provisional number is drawn with a leading `≈` (inside a `bdi`, so it stays first in right to left), a **dashed** boundary (`border-dashed border-input` on a `provisional-surface` that is transparent, never a solid fill or solid border), and a visually hidden "provisional" label. Confirmed values are plain.
- A total that mixes both shows the confirmed part and the provisional part separately. A provisional dashboard card is a dashed card.
- The provisional text is `muted-foreground`; its boundary is `input`, the control boundary, so the dash itself meets 3:1.
- Every dashboard and report view that shows provisional data carries a freshness strip: "Confirmed through <operating day>, today is provisional".

### Brand accent (AC-19)

`--brand` and `--brand-foreground` default to `--primary` and `--primary-foreground`. The portal frame overrides them inline from settings after `deriveBrandTokens` accepts the accent (at least 4.5:1). Use `bg-brand text-brand-foreground` only for the logo tile, a 6px top rule, and the main portal button. Never for status, text, the focus ring, or a chip.

### Measured contrast

Text needs 4.5:1 (3:1 for large text). Control boundaries, the focus ring, and non text marks need 3:1 against what sits next to them. Method: the WCAG 2 formula, the same one `apps/web/src/design/contrast.ts` uses (sRGB channels to linear light, `(L1 + 0.05) / (L2 + 0.05)`); a translucent colour is painted over the surface it sits on first. The numbers are copied from spec 0025 (its [verify.md](../../docs/specs/0025-midnight-silver-cyan/verify.md) has the script and its output), and a spot check of six pairs against the token values reproduced them (foreground on background 15.75 dark and 17.99 light, cyan link 11.60 and 4.98, `input` on the control fill 3.25 dark, owed chip 4.82 light, the secondary edge ends 6.83 and 3.56 dark and 7.05 and 4.36 light). `/design` measures every pair again live in the browser.

**Text and controls**

| Pair                                                        | Dark                   | Light              | Need |
| ----------------------------------------------------------- | ---------------------- | ------------------ | ---- |
| `foreground` on `background`                                | 15.75                  | 17.99              | 4.5  |
| `foreground` on `card`                                      | 14.63                  | 19.34              | 4.5  |
| `foreground` on control fill                                | 13.35                  | 17.19              | 4.5  |
| `foreground` on `accent`                                    | 10.82                  | 16.58              | 4.5  |
| `foreground` on `sidebar`                                   | 15.41                  | 16.87              | 4.5  |
| `foreground` on `popover`                                   | 13.35                  | 19.34              | 4.5  |
| `muted-foreground` on `background`                          | 7.85                   | 7.00               | 4.5  |
| `muted-foreground` on `card`                                | 7.29                   | 7.53               | 4.5  |
| `muted-foreground` on control fill                          | 6.65                   | 6.69               | 4.5  |
| `muted-foreground` on `accent`                              | 5.39                   | 6.45               | 4.5  |
| `muted-foreground` on `sidebar`                             | 7.68                   | 6.56               | 4.5  |
| `primary` (link) on `background`                            | 11.60                  | 4.98               | 4.5  |
| `primary` (link) on `card`                                  | 10.77                  | 5.36               | 4.5  |
| `primary` (link) on `accent`                                | 7.97                   | 4.59               | 4.5  |
| `ring` on `background`                                      | 11.60                  | 4.98               | 3    |
| `ring` on control fill                                      | 9.83                   | 4.76               | 3    |
| `ring` on `sidebar`                                         | 11.35                  | 4.67               | 3    |
| `ring` on `accent`                                          | 7.97                   | 4.59               | 3    |
| `primary-foreground` on solid `primary`                     | 11.60                  | 5.36               | 4.5  |
| `success` on `background`                                   | 12.13                  | 5.10               | 4.5  |
| `success` on `card`                                         | 11.27                  | 5.48               | 4.5  |
| `success` on control fill (chip)                            | 10.28                  | 4.87               | 4.5  |
| `warning` on `background`                                   | 10.60                  | 5.04               | 4.5  |
| `warning` on `card`                                         | 9.84                   | 5.42               | 4.5  |
| `warning` on control fill (chip)                            | 8.98                   | 4.82               | 4.5  |
| `destructive` on `background`                               | 8.52                   | 5.42               | 4.5  |
| `destructive` on `card`                                     | 7.91                   | 5.82               | 4.5  |
| `destructive` on control fill (chip)                        | 7.22                   | 5.18               | 4.5  |
| `destructive` on `destructive-surface`                      | 7.33                   | 5.10               | 4.5  |
| `foreground` on `destructive-surface`                       | 13.54                  | 16.93              | 4.5  |
| `success` on `accent`                                       | 8.33                   | 4.70               | 4.5  |
| `warning` on `accent`                                       | 7.28                   | 4.65               | 4.5  |
| `destructive` on `accent`                                   | 5.85                   | 4.99               | 4.5  |
| `success-foreground` on solid `success`                     | 12.13                  | 5.48               | 4.5  |
| `warning-foreground` on solid `warning`                     | 10.60                  | 5.42               | 4.5  |
| `destructive-foreground` on solid `destructive`             | 8.52                   | 5.82               | 4.5  |
| toast text (`background` on `foreground`)                   | 15.75                  | 17.99              | 4.5  |
| `input` on `background`                                     | 3.83                   | 4.06               | 3    |
| `input` on `card`                                           | 3.56                   | 4.36               | 3    |
| `input` on control fill                                     | 3.25                   | 3.88               | 3    |
| `input` on `sidebar`                                        | 3.75                   | 3.81               | 3    |
| segmented selected border (`input`) on the track (`card`)   | 3.56                   | 4.36               | 3    |
| error boundary (`destructive`) on `background`              | 8.52                   | 5.42               | 3    |
| error toast border (`destructive`) on `destructive-surface` | 7.33                   | 5.10               | 3    |
| main button edge (`primary-edge`) on `background`           | 14.67                  | 7.77               | 3    |
| main button edge on `card`                                  | n/a (measured on page) | 8.35               | 3    |

The weakest control pairs are `input` on control fill in dark (3.25) and `input` on `sidebar` in light (3.81); the weakest text pairs are the cyan link on the light page (4.98) and the owed chip in light (4.82).

The segmented control's selected border is `input` on the selected `accent` fill at 2.63 in dark (3.74 light). That is not a failing pair: the border's neighbour on the outside is the track, which is the pair that matters for a boundary (3.56 and 4.36); the fill inside is the control itself.

**Gradient stops behind or inside text** (each stop alone)

| Stop                                        | Text on it       | Dark  | Light | Need      |
| ------------------------------------------- | ---------------- | ----- | ----- | --------- |
| Primary blend `#F4F7FA`                     | `#0A0E14`        | 17.99 | n/a   | 4.5       |
| Primary blend `#C9D3DE`                     | `#0A0E14`        | 12.76 | n/a   | 4.5       |
| Primary blend `#A9DDF8`                     | `#0A0E14`        | 13.25 | n/a   | 4.5       |
| Primary blend `#7DD3FC`                     | `#0A0E14`        | 11.60 | n/a   | 4.5       |
| Primary blend `#1E293B`                     | `#FFFFFF`        | n/a   | 14.63 | 4.5       |
| Primary blend `#334155`                     | `#FFFFFF`        | n/a   | 10.35 | 4.5       |
| Primary blend `#0E7490`                     | `#FFFFFF`        | n/a   | 5.36  | 4.5       |
| Hero blend light `#155E75`                  | `#FFFFFF`        | n/a   | 7.27  | 4.5       |
| Heading blend `#FFFFFF` on `card`           | (it is the text) | 17.96 | n/a   | 3 (large) |
| Heading blend `#C9D3DE` on `card`           |                  | 11.85 | n/a   | 3         |
| Heading blend `#7DD3FC` on `background`     |                  | 11.60 | n/a   | 3         |
| Heading blend `#0A0E14` on `background`     |                  | n/a   | 17.99 | 3         |
| Heading blend `#334155` on `background`     |                  | n/a   | 9.63  | 3         |
| Heading blend `#0E7490` on `background`     |                  | n/a   | 4.98  | 3         |
| `foreground` on selected row tint           |                  | 10.85 | 16.81 | 4.5       |
| cyan link on selected row tint              |                  | 7.99  | 4.66  | 4.5       |
| owed flag on selected row tint              |                  | 7.30  | 4.71  | 4.5       |
| `muted-foreground` on selected row tint     |                  | 5.40  | 6.54  | 4.5       |
| `foreground` on current page tint (sidebar) |                  | 11.07 | 13.93 | 4.5       |
| `muted-foreground` on sidebar item hover    |                  | 7.08  | 6.04  | 4.5       |
| `muted-foreground` on row hover             |                  | 6.79  | 6.78  | 4.5       |
| owed flag on row hover                      |                  | 9.17  | 4.88  | 4.5       |
| `foreground` on row hover                   |                  | 13.63 | 17.43 | 4.5       |

Tints are translucent, so each pair is measured with the tint painted over its surface (the card, or the sidebar). The figures in the tint rows are the values the browser paints and `/design` shows live (the browser rounds the tint's alpha to two decimals). Tints are measured as painted with a tolerance of 0.1; every opaque pair keeps 0.02 (AC-2).

**Not a pair that matters.** The cyan marker as text on the light current page tint (3.88) is not allowed and is not used: the current page text is `foreground`, and the cyan is only the 2px marker, a non text mark that needs 3:1 (it has 4.67 on the light sidebar).

## Type

Fonts: Geist (Latin), Geist Mono (codes, money, ids, mono labels), Noto Sans Arabic (Arabic). All SIL OFL 1.1, self hosted by the app (`next/font/local`, variables `--font-geist`, `--font-geist-mono`, `--font-noto-arabic` on `<html>` from `apps/web/src/shell/root-fonts.ts`), never from a font host at runtime. Tailwind maps them in `globals.css`:

- `font-sans` and `font-heading`: `var(--font-geist), ui-sans-serif, system-ui, sans-serif`.
- `font-mono`: `var(--font-geist-mono), var(--font-noto-arabic), ui-monospace, monospace`. Noto Sans Arabic sits in the mono stack because Geist Mono has no Arabic glyphs, so an Arabic word in a mono styled label (section label, table header, chip) does not fall to an arbitrary system face.
- `font-arabic`: `var(--font-noto-arabic), var(--font-geist), ui-sans-serif, system-ui, sans-serif`.

Font coverage (variable woff2 files kept in the repo, see `apps/web/src/shell/fonts/README.md`):

- **Files.** Geist and Geist Mono, latin subset, variable; Noto Sans Arabic, arabic subset (`U+6??` and related), wght 100 to 900 (Version 2.012); it covers the Arabic-Indic digits U+0660 to U+0669 and U+06F0 to U+06F9. Only weights 400, 500, and 600 are used.
- **Latin inside Arabic text.** Under `:lang(ar)` the `--font-arabic` stack is Noto Sans Arabic then Geist. The arabic subset has no Latin glyphs, so Western digits, Latin letters, and Latin punctuation inside Arabic text render in Geist, with tabular figures. This keeps numbers identical in both languages. Do not expect Noto Sans Arabic to draw them.
- **Outside the latin subset.** Latin characters beyond it (Latin Extended, Vietnamese) fall back to the system face. Add a subset file before relying on them.
- **First paint.** The generated metric adjusted fallback faces are off (`adjustFontFallback: false`) and `display: swap` is on, so the first paint uses the plain system stack until the font loads. Expect a small text shift on a cold load.
- **No third party host.** Fonts never come from a third party host, at build time or at run time. New faces or subsets are added as files in the repo.
- **Tabular figures (AC-16).** Numeric columns use `tabular-nums`. Whether Geist carries the `tnum` feature is checked in the font file by the frontend developer in M1 and recorded in the fonts README; if it is missing, numeric columns use Geist Mono instead and this section says so.

| Step                 | Utility                                                                           | Face                                                           | Latin size / line     | Arabic size / line    | Weight     |
| -------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------- | --------------------- | ---------- |
| Page title (`h1`)    | `text-xl font-semibold`, heading blend fill, letter spacing -0.03em (0 in Arabic) | Geist                                                          | 20px / 28px           | 21px / 1.7            | 600        |
| Section title (`h2`) | `text-base font-semibold`                                                         | Geist                                                          | 17px / 25.5px         | 18px / 1.7            | 600        |
| Body, the default    | `text-sm`                                                                         | Geist                                                          | 15px / 22.5px         | 16px / 1.75           | 400        |
| Labels, emphasis     | `text-sm font-medium`                                                             | Geist                                                          | 15px / 22.5px         | 16px / 1.75           | 500        |
| Section label        | `section-label`                                                                   | Geist Mono, lowercase, `muted-foreground`, a cyan `//` before | 12px / 16px           | 13px / 1.75           | 400        |
| Table header         | `table-head-look` (on `TableHead`)                                                | Geist Mono, lowercase by CSS only, `muted-foreground`          | 12px / 16px           | 13px / 1.75           | 400        |
| Chips                | `StatusChip`                                                                      | Geist Mono, lowercase                                          | 12px / 16px           | 13px / 1.75           | 400        |
| Secondary, captions  | `text-xs` (captions add `text-muted-foreground`)                                  | Geist                                                          | 12px / 16px           | 13px / 1.75           | 400        |
| Codes, money, ids    | `LtrText`, `tabular-nums`                                                         | Geist Mono, left to right                                      | as the text around it | as the text around it | 400 to 500 |

- Weights 400, 500, and 600 only.
- **How 15px body is expressed (AC-23).** Components keep their classes (`text-sm`, `text-base`); the tokens change instead. `globals.css` retunes `--text-sm` to 0.9375rem and `--text-base` to 1.0625rem, and `body` stays `text-sm`. So every shadcn control and table cell that says `text-sm` is 15px with no component edit. `text-xs` (12px) and `text-xl` (20px) keep Tailwind's defaults. Never write `text-[15px]`. The mockups' 14px body and 44 and 46px controls are not adopted.
- **Page heading (AC-11).** The base layer gives every `h1` the heading blend as its text fill (`gradient-heading`: `background-clip: text`, transparent text) and a letter spacing of -0.03em. Under `@media (forced-colors: active)` and `@supports not (background-clip: text)` it falls back to plain `foreground` (system `CanvasText` in forced colours). The `h1` is also `inline-size: fit-content; max-inline-size: 100%`: the blend spans the element box, so a full width heading would show only its first stops and never reach cyan. A centred or flex-grown heading must be centred by its parent, not by `text-center` on the `h1`. Section titles keep their size and plain `foreground`. Under `:lang(ar)` the letter spacing is 0, because negative spacing breaks cursive joining. Axe may report gradient text as "incomplete" rather than passing; the stop by stop measurement below and the fallback are the mitigation.
- **`//` section labels and lowercase table headers are CSS only.** `section-label` draws `//` in cyan with `::before { content: '//' / ''; margin-inline-end: 1ch }` (a margin, because a trailing space collapses in a flex parent; size and weight sit in `:where()` so a caller class wins) (the empty alternative text keeps it out of screen reader output) with a plain `content: '//'` line before it for a browser that does not read the alternative text syntax. Table headers use `text-transform: lowercase`. No string in the message catalogs changes, and Arabic text is untouched by both.
- **Arabic rule.** Anything under `lang="ar"` (the `:lang(ar)` base rule) switches to `font-arabic` and overrides the same size and line height variables: each step is one pixel larger than the Latin step beside it (body 16px beside 15px, `xs` 13px, section 18px, page title 21px), and the line height is at least 1.7 at every step (body and captions 1.75). Noto Sans Arabic has a smaller optical size than Geist at the same pixel size, hence the extra pixel. Mono styled labels fall through Geist Mono to Noto Sans Arabic for Arabic glyphs; Western digits stay Western. Tune the `:lang(ar)` sizes in `globals.css`, not in components.
- Numbers in columns, totals, and quantities use `tabular-nums`. Digits are Western in both languages, formatted by the app.
- Every code that must read left to right (SKU, barcode, document number, email, URL, version such as `0.0.0-dev`) sits in `LtrText` (`@ssdashboard/ui/components/ltr-text`), never bare text, so right to left pages keep its order. `LtrText` sets `font-mono` (Geist Mono), so codes read apart from names. It keeps the surrounding size; do not mix it into prose.

## Gradients and utilities (spec 0025)

Gradients are named utilities in `globals.css`, never colour variables and never hex in a screen: a screen writes `gradient-primary`. Each reads per theme stops (`--stops-*`), so one name serves both themes. Gradients imitate light (an edge, a glow, a sheen) and never fill a whole surface. Gradients that run along the line read `--line-angle`, `--blend-angle`, `--heading-angle`, and `--sheen-*`, which `[dir='rtl']` mirrors, so the strong end is always at the start edge; top to bottom gradients (the card edge, the marker) do not mirror.

| Utility                   | Look                                                                                                                           | Dark                                                                      | Light                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `gradient-primary`        | The main button fill (text `primary-foreground`), 220% wide so `sheen` can sweep it                                            | `110deg, #F4F7FA 0%, #C9D3DE 34%, #FFFFFF 48%, #A9DDF8 64%, #7DD3FC 100%` | `110deg, #1E293B 0%, #334155 40%, #0E7490 100%`, white text                                            |
| `gradient-heading`        | The `h1` text fill (applied to every `h1` by the base layer)                                                                   | `100deg, #FFFFFF 0%, #C9D3DE 45%, #7DD3FC 100%`                           | `100deg, #0A0E14 0%, #334155 45%, #0E7490 100%`                                                        |
| `gradient-hero`           | Hero tile fill (text `primary-foreground`)                                                                                     | `110deg, #F4F7FA, #C9D3DE 40%, #A9DDF8 70%, #7DD3FC`                      | `110deg, #1E293B, #334155 40%, #155E75 70%, #0E7490`, white text                                       |
| `gradient-card-edge`      | A 1px gradient border on a card (`card` fill in the padding box, edge in the border box; 12px corners from `rounded-card`)     | `180deg, #FFFFFF33, #FFFFFF0D`                                            | `180deg, #0A0E1424, #0A0E140D`                                                                         |
| `gradient-secondary-edge` | The secondary button: control fill with an edge from a lighter slate down to `input` (both ends 3:1 on the page and on a card) | `180deg, #8A9BB2, #5F7088`                                                | `180deg, #475569, #6B7A90` (a darker slate, because a lighter one would lose contrast on a light page) |
| `gradient-glow`           | A soft cyan light behind hero areas                                                                                            | radial `#7DD3FC30` to `#7DD3FC0F` at 38%                                  | the same with `#0E749026` and `#0E74900D`                                                              |
| `gradient-grid`           | A faint 32px grid                                                                                                              | 1px `#FFFFFF08`                                                           | 1px `#0A0E1408`                                                                                        |
| `gradient-selected-row`   | The selected table row tint (`table` rows use it for `data-state="selected"`)                                                  | `90deg, #7DD3FC24, transparent 70%`                                       | `90deg, #0E74901A, transparent 70%`                                                                    |
| `gradient-current-page`   | The current page tint on a sidebar item                                                                                        | `90deg, #7DD3FC29, #7DD3FC05`                                             | `90deg, #0E749024, #0E74900A`                                                                          |
| `gradient-current-marker` | The 2px marker on the leading edge of the current page (the sidebar button draws it with `before:`)                            | `180deg, #FFFFFF, #7DD3FC`                                                | `180deg, #0A0E14, #0E7490`                                                                             |
| `tint-nav`                | Sidebar item hover (alpha only)                                                                                                | `#FFFFFF0A`                                                               | `#0A0E140A`                                                                                            |
| `tint-row`                | Table row hover (alpha only; an ink tint in light)                                                             | `#FFFFFF08`                                                               | `#0A0E140D`                                                                                            |
| `section-label`           | Lowercase mono label with a cyan `//` before                                                                                  | n/a                                                                       | n/a                                                                                                    |
| `table-head-look`         | Lowercase mono table header look                                                                                               | n/a                                                                       | n/a                                                                                                    |

## Spacing, radius, density

- Spacing follows Tailwind's 4px scale. Use `gap-*` for layout, not margins between siblings.
- **Radius (AC-12)** has four named tokens in `globals.css`, each a `rounded-*` utility: `rounded-chip` 6px (chips and menu rows), `rounded-control` 8px (buttons, fields), `rounded-popover` 10px (popovers, menus, tooltips), `rounded-card` 12px (cards and dialogs). The old names stay as aliases so no screen keeps an unnamed radius: `rounded-sm` is chip, `rounded-md` is control, `rounded-lg` and `rounded-xl` are card. New code uses the four names. The old multiplier variable `--radius` is gone.
- Density is compact for data and normal for forms; there is no density toggle. One scope, `floor`, raises it for the hands on a touch screen (below). **The look change does not change one density number.**

| Element                     | Utility                   | Default | `floor` on a coarse pointer |
| --------------------------- | ------------------------- | ------- | --------------------------- |
| Table row                   | `h-row` (`--spacing-row`) | 40px    | 48px                        |
| Table header                | `h-row-header`            | 44px    | 52px                        |
| Form control                | `h-control`               | 40px    | 48px                        |
| Focus ring width            | `--focus-width`           | 2px     | 3px                         |
| Sidebar item (fine pointer) | `h-nav-item`              | 32px    | unchanged                   |
| Shell top bar               | `h-topbar`                | 56px    | unchanged                   |
| Touch target                | `h-touch` / `size-touch`  | 44px    | unchanged                   |

About 20 table rows fit a 1080p screen at 40px.

### The `floor` scope (AC-22)

`floor` is for people who tap and scan all day on a tablet or handheld, not for the operations lead's long tables.

- Put `data-density="floor"` on the container of the confirmation queue and of every scan screen. In `globals.css`, `[data-density='floor']` inside `@media (pointer: coarse)` sets `--spacing-row` 3rem, `--spacing-row-header` 3.25rem, `--spacing-control` 3rem, and `--focus-width` 3px. Everything inside that uses `h-row`, `h-control`, `focus-ring` follows with no class change.
- On a fine pointer (mouse) the scope does nothing: the queue keeps 40px controls there. The scan screens add their own large outcome buttons, at least 48 by 48.
- One outcome per button, with its shortcut visible on the button. On phones the action bar is sticky at the bottom.
- Not for: the order tables, settings, and reports. Do not set it on the page shell.

## Focus, targets, motion, elevation

- **Focus**: `focus-visible` only, the same everywhere: a cyan `ring` outline of `--focus-width` (2px, 3px in `floor`) with a 2px gap (`focus-ring`, and the base `:focus-visible` rule). Items inside clipped lists (menu items) use `focus-ring-inset`, which draws the ring inside by the same width. The ring is 3:1 or better on every surface (table below). Never remove an outline without replacing it.
- **Targets**: every interactive target is at least 24 by 24px. On touch screens (`coarse:` variant, `pointer: coarse`), shell controls and menu, sheet, and command items are at least 44 by 44px; `floor` controls are 48px.
- **Elevation**: flat by default. Light comes from edges, not fills: `gradient-card-edge` on cards, a hairline `ring-border-strong` on popovers and menus plus `shadow-md`, dialogs and sheets `shadow-lg` over a dimmed overlay. No shadows on cards inside pages. The only raised states are the hover lift and the main button sheen shadow below.

### Motion (AC-18, AC-19)

One easing curve for everything: `--ease-ui: cubic-bezier(.2, .7, .2, 1)` (`ease-ui`), one duration `--duration-ui: 180ms`.

| Utility          | What it does                                                                                                                                                               | Time  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `transition-ui`  | Transitions transform, box-shadow, colours, and the sheen position                                                                                                         | 180ms |
| `lift`           | Hover: 1px up and `--shadow-lift` (`0 8px 24px #00000080` dark, a softer `#0A0E1426` light). Not on disabled                                                               | 180ms |
| `press`          | Active: scale to `.98`. Shares one `transform` with `lift` through `--ui-lift` and `--ui-press`                                                                            | 180ms |
| `sheen`          | Hover: the primary blend's `background-position` sweeps (mirrored in right to left) and `--shadow-sheen` appears (`0 8px 28px #7DD3FC40` dark; `#0E749033` light, my pick) | 600ms |
| `enter`          | A section fades in and rises 8px                                                                                                                                           | 500ms |
| `enter-children` | The same for each child, staggered 50ms, 200ms at most                                                                                                                     | 500ms |
| `pop`            | A dropdown opens with a fade and a 4px drop. The menus and popovers use the library animation classes tuned to 150ms with a 4px slide                                      | 150ms |
| `pulse-ui`       | The skeleton pulse                                                                                                                                                         | 1.4s  |

- Buttons carry `transition-ui press` and, for the filled variants, `lift`; the main button also carries `sheen`.
- **Reduced motion is off, not shorter.** Every motion utility is defined only inside `@media (prefers-reduced-motion: no-preference)`, so under `reduce` there is no transform, no animation, and no transition at all (a hovered or pressed button has `transform: none`); and a global rule sets `animation: none` and `transition: none` for the library's own enter and exit animations. The old rule that only shortened durations is gone: a lift that still moves is what some users asked to turn off.

## Look of the base components

Each component keeps its props, structure, density classes (`h-control`, `h-row`, `h-row-header`, `h-nav-item`), and accessibility attributes; only the look changed.

- **Button** (`Button`): `default` is the main button, `gradient-primary` + `primary-edge` border + weight 600 + `lift sheen press`, one per view. `secondary` is the control fill with `gradient-secondary-edge`. `outline` is the page colour with an `input` border. `ghost`, `destructive`, `link` as before. **Disabled** is the `card` fill, `muted-foreground` text, a hairline `border`, no lift, no gradient. Corners `rounded-control`.
- **Fields** (`Input`, `Textarea`, `InputGroup`): the page colour with the `input` boundary and 8px corners. Focus is the 2px cyan ring with the 2px offset (the command palette search input carries its own inset ring). The fields fill with `bg-field`: the page colour everywhere and always in dark, and in light the card colour on a card (`data-slot="card"`, a `gradient-card-edge` surface, a dialog, a sheet, or a popover), set by one `--field` rule in `globals.css`. Screens never pick the field colour. An error uses the `destructive` boundary and the message below.
- **Segmented control and toggle group** (none is vendored and no screen uses one today, so there is nothing to build now; the rule applies the moment the component is first vendored): the track is `card` with a hairline, the selected segment is `accent` with `foreground` text **and a 1px `input` border**, because the selected fill against the track is only 1.35:1 and the border gives the 3:1 boundary (3.56 dark, 4.36 light).
- **Table**: the header is the control fill (`bg-muted`) with a `border-strong` rule and lowercase mono labels (`table-head-look`); rows are 40px, hover is `tint-row`, selected is `gradient-selected-row`.
- **Badge**: the control fill with a `border-strong` edge, `rounded-chip`; the `destructive` variant is `destructive-surface` with a `destructive` border. No cyan fill.
- **Alert**: `card` with a hairline; the `destructive` variant is `destructive-surface` with a `destructive` border and text; the `warning` variant keeps the `card` surface with a `warning` border, text, and triangle icon (9.84 dark, 5.42 light on `card`) for a notice that needs attention but is not an error.
- **Popover, dropdown menu, tooltip, command**: `rounded-popover` panels with a hairline ring; menu rows are `rounded-chip`; menu focus and the command's selected item are `accent`. The tooltip is inverted (`foreground` fill, `background` text).
- **Dialog**: `rounded-card` over a dimmed overlay. **Sheet**: `popover` fill with a start or end hairline.
- **Sidebar**: group labels (`SidebarGroupLabel`) carry the `section-label` look themselves, so a screen passes no class for it; items are `rounded-chip`; hover is `tint-nav` and the current page is `gradient-current-page` (it mirrors in right to left through `--line-angle`, and is never the hover tint) with a 2px `gradient-current-marker` on the leading edge and `foreground` text. The current page text is never cyan.
- **Kbd**: the control fill with a `border-strong` edge, `rounded-chip`.
- **Skeleton**: `muted` fill, `pulse-ui`.
- **Toast** (`Toaster`): inverted (`foreground` fill, `background` text, `rounded-popover`), with Undo as an outline button on the toast text colour when the action can be undone. An error toast is `destructive-surface` with a `destructive` border and `destructive` text (set in `globals.css`, because the toast library's own stylesheet would beat utility classes). Notices that are not errors use `muted-foreground` text with an "i" icon, never cyan. The exception is a needs-attention warning, which uses the Alert `warning` variant (amber border and text, triangle icon), never cyan.
- **Cards** (`gradient-card-edge`, `rounded-card`, the padding the card already has): the dashboard and help parts use them; hovering a card link lifts it.

## Icons

- Lucide (`lucide-react`). Size them through the component (`data-icon="inline-start"` in buttons), not with size classes.
- Decorative icons get `aria-hidden`. An icon only button gets an accessible name (`aria-label` or `sr-only` text).
- **Directional icons mirror in right to left** with `rtl:-scale-x-100`: chevrons (`ChevronLeft`, `ChevronRight`, `ChevronsLeft`, `ChevronsRight`), arrows that point along the line (`ArrowLeft`, `ArrowRight`, `ArrowLeftToLine`, `ArrowRightToLine`, `Undo`, `Redo`), back and forward, `PanelLeft`/`PanelRight`, `LogOut`/`LogIn`, `ListIndent`/`ListOutdent`, and send or reply icons.
- **Never mirror** icons that do not point along the line: search, user, box, map pin, check, warning, up and down arrows and chevrons, `ArrowLeftRight`, clocks, and brand marks.

## Components

### App shell

- Every page renders in `AppShell`: the sidebar, a top bar (`<header>`), and the single `<main id="main-content">`.
- The skip link is the first focusable element and jumps to `#main-content`.
- Sidebar entries come from the typed registry in `apps/web/src/shell/nav.ts`, grouped by module. A group with no visible entries is not rendered. The current page gets `aria-current="page"` (exact match for `/`; for others the most specific entry whose path prefixes the current one, so `/settings/cost-rules` marks Cost rules, not Settings).
- 768px and up: the sidebar collapses to an icon rail (Ctrl+B or Cmd+B, or the toggle), and the state persists in the `sidebar_state` cookie. Below 768px it is a sheet from the start edge, opened by the menu button and closed when you pick a page.
- The top bar holds, in order: menu button (phones), sidebar toggle, client name, location switcher, command palette button, user menu.
- The command palette (Ctrl+K or Cmd+K, from anywhere) lists the registry. Later features register more groups. Esc closes it and focus goes back where it was.
- The location switcher is the source of `useCurrentLocation()`. Stock screens default to it; they never read the cookie themselves.

### Data tables (built by features 7 and 8)

- Build on TanStack Table with the shadcn `Table` parts. Rows are `h-row` (40px; 48px in the `floor` scope on touch), the header `h-row-header` (44px; 52px) on `bg-muted` with lowercase mono labels (`table-head-look`) and a `border-strong` rule.
- Numbers, quantities, and money are end aligned (`text-end`) with `tabular-nums`. Text columns are start aligned.
- Row hover is `hover:tint-row` (an alpha tint in both themes, independent of `accent`); a selected row is `gradient-selected-row` plus a checked row checkbox. Never color alone. Status in a row is a `StatusChip` (icon plus word, at most three, then a "+2" count), in the column order code, who, where, how much, state, cash; provisional amounts follow the provisional rules above.
- **Chips in a row.** At most three `StatusChip`s per row: fulfillment, cash, and one more. Attention (a flag, a note, a problem) is a small flag under the name, not a chip. Anything beyond three collapses into a `StatusChipOverflow` "+N" (a button listing the rest when the row has room for one, otherwise plain text). One line to open the detail: `<Popover><PopoverTrigger asChild><StatusChipOverflow count={n} label={t("...")} /></PopoverTrigger><PopoverContent aria-label={...}>...</PopoverContent></Popover>` (the content needs an accessible name); it forwards `ref` and the trigger props, becomes a button when `onClick`, `interactive`, or any `aria-haspopup`/`aria-expanded`/`aria-controls` is present, and needs no wrapper, effect, or manual focus return; never hide a failed or owed status only behind the count.
- **Column order is fixed**: code, who, where, how much, state, cash. Money and counts end aligned with `tabular-nums`; the state and cash columns hold the chips.
- **Provisional in a table.** A provisional amount is a `ProvisionalValue`: `≈` first (inside a `bdi`, so it stays first in right to left), a dashed `input` boundary on a transparent surface (never solid), `tabular-nums`, and a hidden "provisional" label. A total that mixes both shows the confirmed part and the provisional part as two separate values, never one blended sum. A provisional dashboard card is a dashed card (`border-dashed border-input`).
- **Cash owed always names who owes** (Bosta, a partner, a customer): the `owed` chip label or the cell beside it carries the name, never a bare "Owed".
- **Freshness strip.** Every dashboard and report header is followed by a `FreshnessStrip` ("Confirmed through 4 Nov, today is provisional"), composed and translated by the caller.
- **Row start stripe** (`rowStripeClassName(meaning)`) is decorative only and off by default: the chip already says the meaning. If a screen uses it, it sits on the first cell or a wrapper, and the chip stays.
- **Where they live.** Outside `src/components/` (ADR 0001), one per file: `@ssdashboard/ui/status/status-chip` (`StatusChip`, `{ meaning, label, className }`), `.../status/status-chip-overflow` (`StatusChipOverflow`, `{ count, label, interactive?, className, ...button props }`), `.../status/provisional-value` (`ProvisionalValue`, `{ value, provisionalLabel, className }`), `.../status/freshness-strip` (`FreshnessStrip`, `{ text, className }`), `@ssdashboard/ui/lib/row-stripe` (`rowStripeClassName`), and `@ssdashboard/ui/lib/status-meaning` (the `StatusMeaning` type, `STATUS_MEANINGS`). Icons: check (confirmed), X (failed), coins (owed), clock fading (provisional; lucide has no dashed clock), all `aria-hidden`. A chip with a blank label renders nothing, so no chip is ever icon only. Chips are 24px (`h-6`), `rounded-chip`, mono `text-xs` lowercase, the control fill with a 1px `border-border-strong` and a glowing icon (see Four meaning roles); the provisional chip is transparent with a 1px dashed `border-input`.
- **Density tokens.** `Button` (default, `lg`, `icon`), `Input`, `TableRow` (`h-row`), and `TableHead` (`h-row-header`) take their heights from `h-control`, `h-row`, and `h-row-header`, so the `floor` scope reaches them. The default button is therefore 40px (was 36px); `sm`, `xs`, and sidebar items keep fixed sizes (32 and 24px, sidebar item `h-nav-item`), and shell controls still lift to 44px on touch with `coarse:min-h-touch`.
- Sortable headers are buttons with `aria-sort` on the `th`, and the sort icon is decorative.
- Keep the header row sticky in long tables. Wide tables scroll inside their container, never the page.
- Row actions sit in a trailing column as an icon button with a dropdown menu; the button's name includes the row ("Actions for TBL-OAK-120").
- DropdownMenu is non-modal by default (a modal menu aria-hides the shell and fails axe aria-hidden-focus); no scroll lock; one outside press closes the menu AND activates the pressed control. Keep this when re-copying from shadcn.
- **Arabic cells use 4px vertical padding** because Arabic text runs on a 28px line, so a row stays 40px (`TableCell` sets `[&:lang(ar)]:py-1`). The trim applies only when a table sets no vertical padding of its own: a cell with any `p-`, `py-`, `pt-` or `pb-` class (empty state cells with `py-10`, button cells with `py-0`) keeps exactly that padding in Arabic too.
- **Rows that hold a button stay 40px.** On desktop a row that holds a button is still 40px: the cells around a 32px `sm` button drop their vertical padding (`py-0`) instead of the button shrinking. Touch (coarse pointer) may stay larger, as the density rules above already allow.
- **Exceptions: a note or sentence under an action or in a cell, and a two line cell.** A row that shows an explanatory note under its action (the in-use note on `/seasons` and `/product-groups`) may grow to fit the note: about 52px in English and about 60px in Arabic when the note fits on one line. In a narrow table the note wraps rather than being cut or pushed behind a sideways scroll, and the row grows to fit (up to about 82px in Arabic). A row with a cell of two lines (the style page SKU cost with its "from <date> · from the style" line) may grow to fit it (owner ruling): about 58 to 63px, never more than 64px. A merge suggestion row on `/customers` (review tab) grows the same way to fit its two line customer cell (name with phone below) beside the Merge and Dismiss buttons, with no layout change (owner ruling, 2026-11-16; measured at 1280px: about 48 to 73px in English, about 59px in Arabic). A connection row on `/connections` that shows a health reason or warning sentence grows to fit it like the in-use note rows (about 77 to 80px); rows without a sentence stay 40px. An `/audit` list row grows to fit its two line Record cell (the record type over its number), about 55px in English and about 59px in Arabic at 1280px, and a `/staff` row on the people and partner logins tabs grows to fit its name over email cell in Arabic only, where it runs on two 28px lines (about 56 to 57px at 1280px; English rows stay 40px), both with no layout change (owner ruling, 2026-11-19). None of this text is ever truncated or hidden to save height, and a sentence is never pushed behind a sideways scroll.
- States: loading shows skeleton rows at the real row height; empty uses the empty pattern below inside the table body; an error replaces the body with an inline alert and a retry.

### Forms (built by features 7 and 8)

- Use the shadcn `Field` parts: a visible label above every control (placeholders are hints, never labels), help text below in `text-xs text-muted-foreground`.
- Controls are `h-control` (40px; 48px in the `floor` scope on touch) with an `input` border.
- Validation: `aria-invalid` on the control and `data-invalid` on the field, a `destructive` message linked with `aria-describedby`, shown after blur or submit, never while typing. On submit with errors, focus the first invalid field.
- Required fields say so in the label text ("Required"), not only with an asterisk.
- Buttons: one primary submit at the end of the form, then secondary actions. A pending submit disables the button and shows a spinner with the same label.
- Group related controls with `FieldSet` and a `FieldLegend`. Choices of 2 to 7 options use a `ToggleGroup` or radio group.

### Feedback

- **Toast** (sonner): brief confirmations of something that already happened ("Transfer TR-000123 posted"). Polite live region, at least 5 seconds, never the only place an error appears. A toast is inverted (`foreground` fill, `background` text) with Undo when the action can be undone; an error toast is the `destructive-surface` with a `destructive` border. Notices that are not errors use `muted-foreground` text with an "i" icon, never cyan. The exception is a needs-attention warning, which uses the Alert `warning` variant (amber border and text, triangle icon), never cyan. While a toast is up, `globals.css` pads the page bottom and its scroll padding by 8rem, so a focused element is never hidden behind it (WCAG 2.2 SC 2.4.11).
- **Dialog**: confirms a destructive or hard to undo action. Title says what happens, the destructive button names the action ("Archive", never "OK"), and Cancel is a footer close button. Focus returns to the trigger. A dialog taller than the screen caps at `100dvh` minus `2rem` and scrolls inside (`DialogContent`); its footer is not sticky, so Save and Cancel are reached by scrolling.
- **Empty**: an icon, one sentence on what belongs here, and the action that adds the first item. "No locations yet" style, not "No data".
- **Loading**: skeletons in the shape of the content for lists and cards; a spinner only inside buttons. Announce long loads in a polite live region.
- **Error**: an inline `Alert` with the `destructive` role tokens, what failed in plain words, and a retry. Keep the rest of the page usable.

## Phone first dashboard (AC-20)

The owner's first screen is a phone screen. Design it at 360 by 800, make it work from 320, and never let it scroll sideways from 320 to 430px.

- **One column, numbers first.** Top to bottom, in the same order as the pushed daily report so the owner reads one story in Telegram and in the app: header (brand name, date) and a `FreshnessStrip`; the full width "Cash owed to you" `MetricCard` (`size="lg"`, `emphasis="owed"`, split by Bosta and partners); two half cards in a two column grid (confirmed yesterday, failed delivery rate); the dashed "Today so far" card (`provisional`, its value is a `ProvisionalValue`, so the `≈` shows); the `NeedsYouList`; the `BottomTabs`. The four numbers are owner answer 2.
- **Every card is one link** to its drill down (`MetricCard` renders an `<a>`, `href` required). Nothing inside a card is a second target, and nothing is revealed by hover.
- **Targets**: at least 44 by 44px (`min-h-touch` on cards, 48px rows in the list, 56px tabs). Chips and values inside a card are not targets.
- **Provisional is dashed**, never solid, like every provisional boundary (AC-17). The owed card's start edge (`rowStripeClassName('owed')`, 4px) is decorative; the label and the chip repeat the meaning.
- **Tables collapse to cards below 640px (`sm`).** `CollapsingTable` takes its columns once and draws a table from `sm` up and a card list below: the title column on top, then label and value pairs with the same `StatusChip`s. The other view is `display: none`, so no control is reachable twice and the tab order is one list.
- **The tab bar** (`BottomTabs`): at most four tabs (Today, Orders, Cash, More), 56px (`h-14`), an icon plus a label that is always visible, `aria-current="page"` and the primary fill on the current tab, fixed to the bottom with the safe area inset. A fifth tab is dropped (tested), not squeezed in; extra pages live under "More". Hide it from 768px up where the sidebar takes over. **A phone page with `BottomTabs` must also render `BottomTabsSpacer` (`@ssdashboard/ui/dashboard/bottom-tabs-spacer`) as the last child of its content**, with the same `md:hidden`: it is 56px plus `env(safe-area-inset-bottom)` plus a 16px gap, so the bar never covers a target (axe `target-size`) and `NeedsYouList` keeps a gap above the bar. Never position the bar without the spacer.
- **Needs you** (`NeedsYouList`): at most five rows, most urgent first, each a full width link of at least 48px with a `StatusChip`, a sentence, and a chevron that mirrors in right to left. With more rows, one "N more" link (the app passes `total`, `moreHref`, and `moreLabel(hidden)`).
- **Freshness strip** under the header, composed by the app ("Confirmed through 4 Nov, today is provisional").
- The parts take all text as props and all numbers already formatted, and never import `next/*`. They live at `@ssdashboard/ui/dashboard/metric-card`, `.../bottom-tabs`, `.../bottom-tabs-spacer`, `.../needs-you-list`, and `.../collapsing-table`.
- jsdom checks classes and axe; the 320 to 430px overflow check and measured target sizes belong to the Playwright pass at 360 by 800 with touch, in both languages.

## In screen help (AC-21)

Staff turn over, so help is part of the screen, in three layers that all work from the keyboard and by tap:

1. **`HelpHint`** (`@ssdashboard/ui/help/help-hint`): a question mark button beside a field, column header, or outcome that opens a popover of one or two sentences. 24 by 24px, 44 by 44px on touch. The `label` prop is the accessible name and must say what is explained ("Help: callback delay"), never a bare "Help". It opens by tap, Enter, and Space; Esc closes it and focus returns to the button.
2. **`HelpPanel`** (`.../help/help-panel`): a sheet from the start edge, controlled (`open`, `onOpenChange`), titled by prop. Sections, each drawn only when it has content: numbered steps; an outcome glossary where each outcome shows its real `StatusChip`; the live settings that change the behaviour (passed in already formatted from settings); and the training clip slot (`trainingClip`, a `ReactNode`, empty until a brand records one, captioned in both languages; owner answer 7: text first, Arabic first). A `footer` slot holds the app's "show the checklist again" button. A top bar button opens it (pass it as `trigger`, so focus returns to it), and `useHelpShortcut` (`@ssdashboard/ui/hooks/use-help-shortcut`) opens it on `?`.
3. **`FirstRunChecklist`** (`.../help/first-run-checklist`): per hat, a title, items `{ label, done, href? }`, a progress text ("2 of 4"), and a dismiss button. Controlled: the app derives `done` from real events, stores the dismissal per user and hat, and brings the checklist back from the panel's `footer` button. The component has no memory.

Rules:

- **The `?` rule.** `?` opens the panel only when focus is not in an `input` of a text kind, a `textarea`, a `select`, an editable element, or an element with the role `textbox`, `combobox`, `searchbox`, or `spinbutton`. Ctrl, Cmd, and Alt combinations are ignored; Shift is allowed because `?` needs it. It is never the only way in: the top bar button is always there. With no `trigger`, `HelpPanel` remembers the focused element and returns focus to it on close (Radix only does that for a trigger).
- **Keys.** Help text lives in the message catalogs in `packages/i18n` under `help.<screen>.*` (for example `help.confirmationQueue.steps.1`), in Arabic and English, typed, so a missing Arabic key fails a test. Components never hold help text.
- **Policy values come from settings.** Help that quotes a number (retry count, callback delay) takes it as a message parameter from the live setting and passes it to the panel's `settings`, so it can never be wrong for a brand.
- **Help never holds the only copy of an instruction.** Whatever a user must do is on the screen itself (labels, empty states, errors); help explains and repeats, in the same words as the empty states.
- No hover anywhere; `Popover` and `Sheet` handle Esc, the focus trap (sheet), and focus return.

## Frames

Three frames, one system (AC-18). A frame is a layout plus a few props, not a second set of tokens or components.

|                | Back office                                           | Public portal                                                                 | Partner                                                                               |
| -------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Component      | `AppShell`                                            | `PortalFrame` (`@ssdashboard/ui/frames/portal-frame`)                         | `PartnerFrame` (`@ssdashboard/ui/frames/partner-frame`)                               |
| Audience       | staff, `(backoffice)`                                 | customers, `(portal)`                                                         | consignment partners, `(partner)`                                                     |
| Navigation     | sidebar by module, command palette, location switcher | none: logo, language switch, optional back link                               | top bar links (statements, stock at your location, settlement) and the partner's name |
| Density        | dense tables and forms, `floor` on scan screens       | one column, 320px baseline                                                    | dense, simpler tables, no cost columns                                                |
| Identity       | client name                                           | brand logo and accent (AC-19)                                                 | brand logo, partner name                                                              |
| Network budget | normal                                                | tight (AC-23): one Arabic weight pair first, system face meanwhile, few icons | normal                                                                                |

**`PortalFrame`** contains: a 6px `bg-brand` top rule, a header (36px logo tile, brand name, a `languageSwitch` slot), an optional `backLink` slot, the one `h1`, and one centred column (`max-w-88` with `px-4`, so 20rem of content at 320px and never wider). It never contains a sidebar, command palette, staff navigation, or location switcher. It has `overflow-x-clip`, so the frame adds no sideways scroll at 320 to 430px; large inputs and the main button are the page's job.

**`PartnerFrame`** contains: a bar with the logo tile, brand name, the partner's name and an `actions` slot, then a `<nav aria-label>` of plain `<a>` links (`aria-current="page"` on the current one, 44px tall) and the `main` with the one `h1`. On a phone the bar wraps and the navigation scrolls inside itself, so the page does not scroll sideways. It never contains a sidebar, location switcher, or command palette.

Both render exactly one `<main id="main-content" tabindex="-1">` and exactly one `<h1>` (the `title` prop), take all text through props, and use logical sides and role tokens only. They do not suppress the landmark; a page that nests a frame inside another `main` is the page's bug (see integration below).

### Brand rule (AC-19)

The brand is `{ name, logoUrl?, tokens? }`. When `tokens` (the output of an accepted `deriveBrandTokens`) is given, the frame sets `--brand` and `--brand-foreground` inline on its root; without tokens no inline style is written and the neutral primary shows. The logo `<img>` takes its `alt` from the brand name; with no logo the tile shows the first letter of the name.

- The accent may colour only: the logo tile, the 6px portal top rule, and the one main portal button (`bg-brand text-brand-foreground`).
- It may never colour: status or meaning colours, text, links, the focus ring, chips, borders of inputs, or the partner navigation.
- `deriveBrandTokens(accent)` takes `#RGB` or `#RRGGBB`, picks white (`#FFFFFF`) or the near black `#0A0E14` (the light `--foreground`), whichever has more WCAG 2 contrast, and accepts at 4.5:1 or more. Below that it refuses (`reason: 'contrast'`) and returns the best ratio plus a `suggestion`: the nearest passing colour, found by moving only HSL lightness in 0.25 percent steps (darker tried before lighter), so hue and saturation stay the brand's. A bad string answers `reason: 'invalid'`. It never throws. On any refusal the caller passes no tokens, so the portal falls back to the neutral primary; it never applies a refused accent.
- Until a brand sends its own, design against the sample green `#0A7C39` (owner answer 6).

Worked examples (measured with the WCAG 2 formula, `node --experimental-strip-types` against `src/lib/brand-tokens.ts`):

| Accent                 | With white | With `#0A0E14` | Result                                                     |
| ---------------------- | ---------- | -------------- | ---------------------------------------------------------- |
| `#0A7C39` sample green | 5.31       | 3.64           | accepted, white, 5.31                                      |
| `#F2C230` yellow       | 1.68       | 11.54          | accepted, near black, 11.54                                |
| `#997311` mid ochre    | 4.36       | 4.43           | refused (4.43); suggestion `#9B7511`, 4.56 with near black |
| `#797979` mid grey     | 4.35       | 4.44           | refused (4.44); suggestion `#7A7A7A`, 4.51 with near black |

A colour fails both foregrounds only near mid luminance (relative luminance roughly 0.183 to 0.197 against this near black, a narrow window since the near black got darker in spec 0025: the old worked examples `#A9780B` and `#808080` now pass with it); a pale yellow passes with the dark foreground.

### Integration note (not done here)

`apps/web/src/shell/public-root-frame.tsx` already renders `<main id="main-content">` around every portal and partner page. When a feature wires `PortalFrame` or `PartnerFrame` into those route groups, the root frame must stop rendering `main` (keep the skip link and providers), or the page gets two landmarks. The `/design` gallery has its own `main`, so show the frames there in a dev only preview route (or an iframe), not nested inside the gallery.

## Right to left

- `dir` on `<html>` drives layout; Radix reads its own `DirectionProvider`, so both always change together. Direction follows the language: Arabic is right to left, English left to right. The language switch (user menu, Language) changes `lang`, `dir`, and the Radix direction at once and saves the choice in the `ss_lang` cookie (spec 0004).
- Components take all text through props (labels, titles, `aria-label`, `placeholder`, `alt`); `lint` fails on a raw literal. Numbers, money, and dates are formatted by the app through its shared formatters (Western digits in both languages), never inside a component.
- Write layout once with logical sides; it mirrors on its own. Sheets and sidebars take `side="start" | "end"`.
- Tab order follows DOM order, so it mirrors with the layout.

## Motion and edge utilities, fixes after M1 review

- **`transition-ui` leaves `background-position` out** and lists `transform`; `sheen` owns the 600ms sweep with doubled specificity (`&.sheen`), so it wins over `transition-ui` on the same button whatever the emit order (AC-18).
- **`lift` and `press` set `transform` only in their hover and active states (never at rest)**, so an idle button has no transform and is not a stacking context. Under reduced motion neither exists.
- **`gradient-card-edge` sets its 1px border inside `:where()`** (zero specificity), so a start stripe (`border-s-4 border-s-owed`) always shows.
- **Toast actions**: only `[data-button]:not([data-cancel])` (the Undo action) gets the outline; sonner's cancel button keeps its own look.
