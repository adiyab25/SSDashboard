---
source: spec 0003 (direction set in the spec, no external design)
tokens: packages/ui/src/styles/globals.css
gallery: /design (development only)
---

# SSDashboard design system

The look of the back office: quiet, neutral, and dense, built for long days of tables, forms, and scan screens. Zinc grays, a black and white primary with no colored accent, 10px corners, and IBM Plex Sans in English and Arabic. Hue appears only where it means something (in stock, low, error, info).

Token values live in [`src/styles/globals.css`](src/styles/globals.css). This file holds the rules for using them. The live versions of everything here, with measured contrast, are on `/design` in development.

## Build mandate

- Use role tokens only (`bg-background`, `text-muted-foreground`, `border-input`). No raw hex, rgb, oklch, or Tailwind palette classes (`bg-zinc-200`) in components or pages.
- Use logical sides only: `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `border-s`/`border-e`, `rounded-s`/`rounded-e`, `text-start`/`text-end`. `pnpm lint` fails on physical ones (`check-logical-css.mjs`).
- No text inside `packages/ui`. Every label, including screen reader only ones, arrives as a prop. Apps pass text through `t()`.
- Every page renders inside the app shell and has exactly one `<h1>`.
- Every interactive control works from the keyboard, shows the focus ring, and has an accessible name.

## Color roles

Light values are in `:root`, dark values in `.dark`. Modes are Light, Dark, and System (the default), chosen in the user menu.

| Role | Used for |
|---|---|
| `background` / `foreground` | The page and its text |
| `card`, `popover` (+ `-foreground`) | Raised surfaces: cards, menus, dialogs, sheets |
| `primary` (+ `-foreground`) | The one main action in a view. Near black in light, near white in dark |
| `secondary`, `accent`, `muted` (+ `-foreground`) | Quiet fills: secondary buttons, hover and selected rows, chips |
| `muted-foreground` | Secondary text, placeholders, captions |
| `border` | Decorative separators and card edges only (exempt from 3:1) |
| `input` | The boundary of anything you can operate: fields, outline buttons, checkboxes |
| `ring` | The focus ring |
| `destructive`, `success`, `warning`, `info` (+ `-foreground`) | Meaning only: errors and deletes, in stock, low stock, notices. Never decoration |
| `sidebar-*` | The app shell sidebar |

The primary is monochrome, so hierarchy comes from fill versus outline, weight, and placement. Keep one filled primary button per view.

### Measured contrast

Text needs 4.5:1 (3:1 for large text). Control boundaries and the focus ring need 3:1 against what sits next to them. Measured from the tokens (oklch to sRGB, WCAG 2 formula); `/design` measures them again live in the browser.

| Pair | Light | Dark | Needs |
|---|---|---|---|
| foreground on background | 19.89 | 19.05 | 4.5 |
| card-foreground on card | 19.89 | 16.98 | 4.5 |
| popover-foreground on popover | 19.89 | 16.98 | 4.5 |
| primary-foreground on primary | 16.98 | 16.98 | 4.5 |
| secondary-foreground on secondary | 16.11 | 14.26 | 4.5 |
| accent-foreground on accent | 16.11 | 14.26 | 4.5 |
| muted-foreground on background | 6.85 | 8.60 | 4.5 |
| muted-foreground on card | 6.85 | 7.67 | 4.5 |
| muted-foreground on muted | 6.22 | 6.44 | 4.5 |
| muted-foreground on sidebar | 6.56 | 7.67 | 4.5 |
| destructive on background | 5.85 | 7.44 | 4.5 |
| destructive-foreground on destructive | 5.60 | 7.44 | 4.5 |
| success on background | 5.90 | 9.90 | 4.5 |
| success-foreground on success | 5.65 | 9.90 | 4.5 |
| warning on background | 6.34 | 10.54 | 4.5 |
| warning-foreground on warning | 6.07 | 10.54 | 4.5 |
| info on background | 6.58 | 8.59 | 4.5 |
| info-foreground on info | 6.30 | 8.59 | 4.5 |
| sidebar-foreground on sidebar | 19.05 | 16.98 | 4.5 |
| sidebar-accent-foreground on sidebar-accent | 14.87 | 14.26 | 4.5 |
| input on background | 3.96 | 5.02 | 3 |
| input on card / popover | 3.96 | 4.48 | 3 |
| input on sidebar | 3.79 | 4.48 | 3 |
| ring on background | 17.73 | 19.05 | 3 |
| ring on card / sidebar | 17.73 / 16.98 | 16.98 | 3 |

Disabled controls are exempt from contrast but stay at 3:1 or more, so a disabled "No locations yet" is still readable.

## Type

| Step | Utility | Size / line height | Weight |
|---|---|---|---|
| Page title (`h1`) | `text-xl font-semibold` | 20px / 28px | 600 |
| Section title (`h2`) | `text-base font-semibold` | 16px / 24px | 600 |
| Body, the default | `text-sm` | 14px / 20px | 400 |
| Labels, emphasis | `text-sm font-medium` | 14px / 20px | 500 |
| Secondary, captions | `text-xs text-muted-foreground` | 12px / 16px | 400 |

- Weights 400, 500, and 600 only.
- IBM Plex Sans for Latin text. Anything under `lang="ar"` switches to IBM Plex Sans Arabic with one more step of line height. Both are served by the app (`next/font`), never from a font host at runtime.
- Numbers in columns, totals, and quantities use `tabular-nums` so digits line up.
- Every code that must read left to right (SKU, barcode, document number, email, URL, version such as `0.0.0-dev`) sits in `LtrText` (`@ssdashboard/ui/components/ltr-text`), never bare text, so right to left pages keep its order.

## Spacing, radius, density

- Spacing follows Tailwind's 4px scale. Use `gap-*` for layout, not margins between siblings.
- Radius is `--radius: 0.625rem` (10px): `rounded-lg` for cards and dialogs, `rounded-md` for controls, `rounded-sm` for items inside menus.
- Density is compact for data and normal for forms. There is no density toggle.

| Element | Utility | Height |
|---|---|---|
| Table row | `h-row` | 36px |
| Table header | `h-row-header` | 40px |
| Form control | `h-control` (the Vega default) | 36px |
| Sidebar item (fine pointer) | `h-nav-item` | 32px |
| Shell top bar | `h-topbar` | 56px |
| Touch target | `h-touch` / `size-touch` | 44px |

## Focus, targets, motion, elevation

- **Focus**: `focus-visible` only, the same everywhere: a 2px `ring` outline with a 2px gap (`focus-ring`). Items inside clipped lists (menu items) use `focus-ring-inset`. Never remove an outline without replacing it.
- **Targets**: every interactive target is at least 24 by 24px. On touch screens (`coarse:` variant, `pointer: coarse`), shell controls and menu, sheet, and command items are at least 44 by 44px.
- **Motion**: the shadcn defaults (150 to 200ms fades, zooms, and slides), all switched off under `prefers-reduced-motion: reduce`.
- **Elevation**: flat by default. Popovers and menus use `shadow-md` plus a hairline ring; dialogs and sheets `shadow-lg` over a dimmed overlay. No shadows on cards inside pages.

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

- Build on TanStack Table with the shadcn `Table` parts. Rows are `h-row` (36px), the header `h-row-header` (40px) on `bg-muted` with `font-medium` labels.
- Numbers, quantities, and money are end aligned (`text-end`) with `tabular-nums`. Text columns are start aligned.
- Row hover is `hover:bg-muted`; a selected row is `bg-accent` plus a checked row checkbox. Never color alone.
- Sortable headers are buttons with `aria-sort` on the `th`, and the sort icon is decorative.
- Keep the header row sticky in long tables. Wide tables scroll inside their container, never the page.
- Row actions sit in a trailing column as an icon button with a dropdown menu; the button's name includes the row ("Actions for TBL-OAK-120").
- DropdownMenu is non-modal by default (a modal menu aria-hides the shell and fails axe aria-hidden-focus); no scroll lock; one outside press closes the menu AND activates the pressed control. Keep this when re-copying from shadcn.
- States: loading shows skeleton rows at the real row height; empty uses the empty pattern below inside the table body; an error replaces the body with an inline alert and a retry.

### Forms (built by features 7 and 8)

- Use the shadcn `Field` parts: a visible label above every control (placeholders are hints, never labels), help text below in `text-xs text-muted-foreground`.
- Controls are the Vega default height (36px) with an `input` border.
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
