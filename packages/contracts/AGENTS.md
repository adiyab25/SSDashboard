# packages/contracts

## Overview

The shared API contract: Zod schemas and their inferred types, used by the api for validation and the OpenAPI document, and by the web through the generated `openapi-fetch` client.

## Stack

TypeScript, Zod (`catalog:` version). Built to `dist/` with `tsc`; consumers import the built output, so build before typechecking dependents (Turborepo handles this).

## Commands

```bash
pnpm --filter @ssdashboard/contracts build
pnpm --filter @ssdashboard/contracts test   # test/*.spec.ts
```

## Conventions

- One file per module's shapes (`src/health.ts`), re-exported from `src/index.ts`.
- Schemas are the source of truth; export types with `z.infer`, never a hand written duplicate.
- The generated OpenAPI document and client (`openapi-typescript`, added with the first real endpoint) live here and are committed; CI fails if they are stale.
- ESM with NodeNext resolution: relative imports need the `.js` suffix.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
