# packages/config

## Overview

Shared configuration every workspace extends: TypeScript presets today, and the ESLint and Prettier config once `/develop tooling` adds them.

## Key files

| File | Owns |
|---|---|
| `tsconfig/base.json` | Strict compiler options every preset inherits |
| `tsconfig/nextjs.json` | Preset for `apps/web` |
| `tsconfig/node-library.json` | Preset for the packages |
| `tsconfig/react-library.json` | Preset for React packages outside Next.js (`packages/ui`) |
| `eslint/react.js` | ESLint for React packages: the base rules plus jsx-a11y |
| `scripts/check-logical-css.mjs` | Fails `lint` on physical side styles in `packages/ui` and `apps/web` (spec 0003); its tests and planted fixtures sit beside it |

## Commands

```bash
pnpm --filter @ssdashboard/config test   # the logical CSS check's own tests (node --test)
```

## Conventions

- Loosening an option here loosens it everywhere. Keep `strict` and `noUncheckedIndexedAccess` on; override per workspace only with a reason in a comment.
- A line the logical CSS check must skip carries `logical-css-ignore: <reason>` on it or the line above; `ltr:` and `rtl:` scoped utilities are always allowed.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
