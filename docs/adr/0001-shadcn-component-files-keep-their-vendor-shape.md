# 0001. shadcn component files keep their vendor shape

- **Status**: accepted
- **Date**: 2026-11-05
- **Spec**: [0007 Stack architecture and operations layer](../specs/0007-stack-architecture-operations-layer/index.md)

## Context

Our conventions say one component per file and a file named after its component. The design
system is shadcn/ui, whose components are copied into `packages/ui/src/components/` by the CLI and
are shaped as compound components: `dialog.tsx` holds `Dialog`, `DialogTrigger`, `DialogContent`,
and more; `sidebar.tsx` and `table.tsx` do the same. The CLI also writes `cn()` into
`src/lib/utils.ts`, and `components.json` and every generated component import it from
`@/lib/utils`, which is a banned name (`utils`). Splitting those files or renaming that one would
fight every `shadcn add` and update, and make each upstream diff unreadable.

## Decision

We will exempt `packages/ui/src/components/**` from `react/no-multi-comp` and from the component
export name check, and exempt the exact path `packages/ui/src/lib/utils.ts` from the banned names
check. Feature code (`apps/web`, and `packages/ui` outside `components/`) stays strict.

## Consequences

- `shadcn add` and updates apply cleanly and diff against upstream.
- The exemptions are path scoped: the same multi component file outside `components/` still fails
  (fixture cases in `packages/config/scripts/fixtures` prove it).
- Our own components must not live in `packages/ui/src/components/`; if one is ever added there it
  loses the one component per file check, so review it by hand.
- The exemptions live in `packages/config/eslint/react.js`,
  `packages/config/scripts/check-component-export-names.mjs`, and
  `packages/config/scripts/check-banned-names.mjs`, each with a comment pointing here.
