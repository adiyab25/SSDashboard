# apps/api

## Overview

The NestJS backend that holds every business rule. One codebase, three entry points in the `app` image: `api` (HTTP, `src/main.ts`), `worker` (pg-boss jobs, added when the first job lands), and `migrate` (`src/migrate.ts`, runs migrations and exits).

## Key files

| File | Owns |
|---|---|
| `src/main.ts` | HTTP bootstrap: `/api` prefix, trust proxy, extension loading |
| `src/migrate.ts` | The migrate entry point (the only place migrations run) |
| `src/app.module.ts` | Root module, imports each business module |
| `src/config/env.ts` | Zod env schema, validated at startup |
| `src/database/database.module.ts` | Drizzle client provider |
| `src/extensions/load-extensions.ts` | Loads `extensions/<client>` packages listed in `EXTENSIONS` |

## Commands

```bash
pnpm --filter @ssdashboard/api dev        # Watch mode on port 3001
pnpm --filter @ssdashboard/api test       # Unit tests (src/**/*.spec.ts)
pnpm --filter @ssdashboard/api test:e2e   # test/*.e2e-spec.ts against Postgres (build first)
```

## Conventions

- One folder per business module under `src/<module>/`, holding its module, services, controllers, and specs side by side.
- Read config only through the injected `ENV` token, never `process.env` directly; add every new variable to `env.ts` and `.env.example`.
- Database access goes through the Drizzle client from `database.module.ts`; tables are defined in `packages/db`, not here.
- Validate query strings with `new ZodQueryPipe(<contract schema>)` (`src/platform/zod-query.pipe.ts`); a bad query answers 400 with the stable code `INVALID_QUERY`.
- List endpoints page with a keyset cursor (the last row's sort key, base64url encoded) and compare and order with `COLLATE "C"`, so pages never skip or repeat rows (`src/inventory/locations/locations.service.ts`).
- Query helpers (`and`, `inArray`, `isNull`, `sql`) come from `@ssdashboard/db`, never straight from `drizzle-orm`, so the repo shares one Drizzle copy.

## Gotchas

- ESM with NodeNext resolution: relative imports need the `.js` suffix (`./app.module.js`).
- The api never migrates on boot. Run `pnpm db:migrate`, which builds the api first.
- Better Auth (feature 6) needs NestJS's body parser off for `/api/auth`, and its cookie stays host only, `Secure`, `HttpOnly`, `SameSite=Lax`.
- The core never imports an extension; extensions load by dynamic import only.

## Agent skills

- [nestjs-best-practices](../../.claude/skills/nestjs-best-practices/): `kadajett/agent-nestjs-skills`, modules, DI, security, performance
- [drizzle-orm-patterns](../../.claude/skills/drizzle-orm-patterns/): `giuseppe-trisciuoglio/developer-kit`, queries, transactions, row locks
- Auth work (feature 6), from `better-auth/skills`: [better-auth-best-practices](../../.claude/skills/better-auth-best-practices/), [better-auth-security-best-practices](../../.claude/skills/better-auth-security-best-practices/), [email-and-password-best-practices](../../.claude/skills/email-and-password-best-practices/), [two-factor-authentication-best-practices](../../.claude/skills/two-factor-authentication-best-practices/), [organization-best-practices](../../.claude/skills/organization-best-practices/), [create-auth](../../.claude/skills/create-auth/). Move these to `src/auth/AGENTS.md` once that folder exists.

## Related specs

- [0001 Stack & architecture](../../docs/specs/0001-stack-architecture/index.md)

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
