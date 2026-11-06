# Design system (`@ssdashboard/ui`)

The shared components and design tokens: shadcn/ui on Radix and Tailwind v4, plain React. The written standard is [DESIGN.md](DESIGN.md).

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- Tokens (Daftar: colors, the four meaning roles, brand, type, density and the `floor` scope) and the Tailwind theme mapping: [src/styles/globals.css](src/styles/globals.css)
- Components, one per file: [src/components/](src/components/)
- The `cn()` helper: [src/lib/utils.ts](src/lib/utils.ts)
- Hooks the components use: [src/hooks/use-mobile.ts](src/hooks/use-mobile.ts)
- The axe test helper: [src/test/axe.ts](src/test/axe.ts)
- The design standard: [DESIGN.md](DESIGN.md)

## Never touches

- `apps/*`, `@ssdashboard/contracts`, or `next/*`.
- Text of its own. Every label, including screen reader only ones, arrives as a prop.
- Raw colors or physical side classes. Use role tokens and logical classes (`ms-`, `pe-`, `start-`).

## How to test

```bash
pnpm --filter @ssdashboard/ui test
pnpm --filter @ssdashboard/ui typecheck
```

Each component has a spec beside it with an axe check.

## Governing spec

- [0003 Design system and UI foundation](../../docs/specs/0003-design-system-ui-foundation/index.md)
- [0004 Localization](../../docs/specs/0004-localization/index.md) (right to left)

## Decisions

- [ADR 0001 shadcn component files keep their vendor shape](../../docs/adr/0001-shadcn-component-files-keep-their-vendor-shape.md)
