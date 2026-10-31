# packages/config

## Overview

Shared configuration every workspace extends: TypeScript presets today, and the ESLint and Prettier config once `/develop tooling` adds them.

## Key files

| File | Owns |
|---|---|
| `tsconfig/base.json` | Strict compiler options every preset inherits |
| `tsconfig/nextjs.json` | Preset for `apps/web` |
| `tsconfig/node-library.json` | Preset for the packages |

## Conventions

- Loosening an option here loosens it everywhere. Keep `strict` and `noUncheckedIndexedAccess` on; override per workspace only with a reason in a comment.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
