# packages/ui

## Overview

`@ssdashboard/ui`, the shared design system: shadcn/ui components (Radix primitives, Vega style), the Daftar design tokens (warm paper, indigo primary, Inter, Noto Sans Arabic, JetBrains Mono), and the hooks they need. Plain React, so a future storefront or POS app can use it too. Decision: [spec 0003](../../docs/specs/0003-design-system-ui-foundation/index.md).

## Key files

| File | Owns |
|---|---|
| `src/styles/globals.css` | Tokens (oklch CSS variables, light in `:root`, dark in `.dark`), the `@theme inline` mapping, base layer |
| `src/components/*.tsx` | shadcn components in their vendor shape (compound files like `dialog.tsx` hold several components; exempt from the one component rule by [ADR 0001](../../docs/adr/0001-shadcn-component-files-keep-their-vendor-shape.md)), imported as `@ssdashboard/ui/components/<name>` |
| `src/status/*.tsx` | Status display, one component per file (`status-chip`, `status-chip-overflow`, `provisional-value`, `freshness-strip`), imported as `@ssdashboard/ui/status/<name>`; outside `src/components/`, so the one component rules apply |
| `src/frames/*.tsx` | `PortalFrame`, `PartnerFrame`, and their shared `BrandMark`, imported as `@ssdashboard/ui/frames/<name>`; each renders the one `main` and the one `h1`, the brand accent goes on the frame root as inline `--brand` tokens |
| `src/dashboard/*.tsx` | Phone first dashboard parts (`metric-card`, `bottom-tabs`, `bottom-tabs-spacer`, `needs-you-list`, `collapsing-table`), imported as `@ssdashboard/ui/dashboard/<name>`; plain `<a>` links, no `next/*`, tabs capped at four, list at five |
| `src/help/*.tsx` | In screen help (`help-hint`, `help-panel`, `first-run-checklist`), imported as `@ssdashboard/ui/help/<name>`; text arrives as props, the app owns open state, dismissal, and the `help.<screen>.*` keys |
| `src/lib/brand-tokens.ts` | `deriveBrandTokens(accent)` (4.5:1 gate, nearest passing suggestion), `FrameBrand`, `brandStyle` |
| `src/lib/status-meaning.ts`, `src/lib/row-stripe.ts` | The `StatusMeaning` type and the decorative `rowStripeClassName` |
| `src/lib/utils.ts` | `cn()`; the one file allowed the banned name `utils` (ADR 0001) |
| `src/hooks/*.ts` | Hooks the components use (`use-mobile`, `use-help-shortcut`) |
| `src/test/axe.ts` | `expectNoAxeViolations()` for component tests |
| `DESIGN.md` | The written design standard (direction B, Daftar): color and meaning roles with measured contrast, type, density and the `floor` scope, focus, icons, and table, form, and feedback rules |

## Commands

```bash
pnpm --filter @ssdashboard/ui test        # Vitest + axe, beside each component
pnpm --filter @ssdashboard/ui typecheck
```

## Conventions

- Consumed as TypeScript source, no build step: `apps/web` lists it in `transpilePackages` and scans it with `@source` in its `globals.css`.
- Never import from `apps/*`, `@ssdashboard/contracts`, or `next/*`.
- No text of its own: every label, including screen reader only ones, arrives as a prop.
- Role tokens only (`bg-muted`, `text-foreground`); no raw colors or Tailwind palette classes.
- Logical sides only (`ms-`, `pe-`, `start-`, `border-e`); directional icons get `rtl:-scale-x-100`.
- Every component gets a spec with an axe check; overlays are checked on `document.body`.
- Radix Dialog returns focus only to a trigger; `HelpPanel` stores the opener itself for the `?` key path. Radix restores focus in a timeout, so tests that check it use `waitFor`.
- Our own components never go in `src/components/` (that folder is exempt from the one component per file checks); put them elsewhere in `src/`, one per file, named after the file.

## Gotchas

- `shadcn add` run inside this folder writes to the wrong place in this repo. Generate components in a scratch shadcn monorepo (`init --template next --monorepo --base radix --preset vega --rtl`), copy them into `src/components/`, rewrite `@workspace/ui/` to `@ssdashboard/ui/`, then run Prettier and the logical CSS check.
- `shadcn init --rtl` leaves some physical side classes behind (sheet, sidebar, popper animations); convert them when you copy a component in.
- Type is token driven: `--text-sm` is 15px and `:lang(ar)` re-sets the size and line height variables, so never hard code a font size in a component. Density and focus width are variables too (`--spacing-row`, `--spacing-control`, `--focus-width`); the `floor` scope (`data-density="floor"`, coarse pointers only) changes them.
- DropdownMenu is non-modal by default (a modal menu aria-hides the shell and fails axe aria-hidden-focus); no scroll lock; one outside press closes the menu AND activates the pressed control. Keep this when re-copying from shadcn.

## Agent skills

- [shadcn](../../.claude/skills/shadcn/): `shadcn-ui/ui`, components, composition rules, theming
- [tailwind-4-docs](../../.claude/skills/tailwind-4-docs/): `lombiq/tailwind-agent-skills`, Tailwind v4 utilities, variants, `@theme`

Declined: Radix UI, next-themes, cmdk, and axe specific skills (no strong match, 2026-11-03; the shadcn and Playwright skills cover them). MCP servers: none credible for these tools.
