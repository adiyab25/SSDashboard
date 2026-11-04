# packages/ui

## Overview

`@ssdashboard/ui`, the shared design system: shadcn/ui components (Radix primitives, Vega style, zinc), the design tokens, and the hooks they need. Plain React, so a future storefront or POS app can use it too. Decision: [spec 0003](../../docs/specs/0003-design-system-ui-foundation/index.md).

## Key files

| File | Owns |
|---|---|
| `src/styles/globals.css` | Tokens (oklch CSS variables, light in `:root`, dark in `.dark`), the `@theme inline` mapping, base layer |
| `src/components/*.tsx` | shadcn components, one per file, imported as `@ssdashboard/ui/components/<name>` |
| `src/lib/utils.ts` | `cn()` |
| `src/hooks/*.ts` | Hooks the components use (`use-mobile`) |
| `src/test/axe.ts` | `expectNoAxeViolations()` for component tests |
| `DESIGN.md` | The written design standard: color roles with measured contrast, type, density, focus, icons, and table, form, and feedback rules |

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

## Gotchas

- `shadcn add` run inside this folder writes to the wrong place in this repo. Generate components in a scratch shadcn monorepo (`init --template next --monorepo --base radix --preset vega --rtl`), copy them into `src/components/`, rewrite `@workspace/ui/` to `@ssdashboard/ui/`, then run Prettier and the logical CSS check.
- `shadcn init --rtl` leaves some physical side classes behind (sheet, sidebar, popper animations); convert them when you copy a component in.
- DropdownMenu is non-modal by default (a modal menu aria-hides the shell and fails axe aria-hidden-focus); no scroll lock; one outside press closes the menu AND activates the pressed control. Keep this when re-copying from shadcn.

## Agent skills

- [shadcn](../../.claude/skills/shadcn/): `shadcn-ui/ui`, components, composition rules, theming
- [tailwind-4-docs](../../.claude/skills/tailwind-4-docs/): `lombiq/tailwind-agent-skills`, Tailwind v4 utilities, variants, `@theme`

Declined: Radix UI, next-themes, cmdk, and axe specific skills (no strong match, 2026-11-03; the shadcn and Playwright skills cover them). MCP servers: none credible for these tools.
