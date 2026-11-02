# packages/db

## Overview

The Drizzle schema for every module (Better Auth tables included) and the only migration history. The api's `migrate` entry point applies these migrations; nothing else does.

## Stack

Drizzle ORM and drizzle-kit, `pg` driver, PostgreSQL 18 with `pg_trgm` and `unaccent` (enabled by `migrations/0000_enable_extensions.sql`).

## Commands

```bash
pnpm db:generate                                 # From the repo root: new SQL migration from the schema
pnpm --filter @ssdashboard/db test               # Unit tests
pnpm --filter @ssdashboard/db test:e2e           # Against Postgres from deploy/compose.dev.yaml
```

## Conventions

- Tables live under `src/schema/`, one file per module, re-exported from `src/schema/index.ts`.
- Review every generated SQL migration before committing it; migrations are plain SQL and part of the release.

## Gotchas

- Never edit or delete a migration that has shipped. Fix forward with a new one.
- Each migration runs in a transaction. Anything that cannot (`CREATE INDEX CONCURRENTLY`) goes in its own small migration that is safe to run twice.
- Expand and contract: add the new column, move data in SQL, drop the old one at least one minor release later.
- Extensions keep their own tables in their own schema and never migrate core tables.

## Agent skills

- [drizzle-orm-patterns](../../.claude/skills/drizzle-orm-patterns/): `giuseppe-trisciuoglio/developer-kit`, schema and migrations
- [postgresql-table-design](../../.claude/skills/postgresql-table-design/): `wshobson/agents`, types, indexes, constraints

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
