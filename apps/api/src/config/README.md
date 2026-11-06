# Configuration

The one place the api reads its environment. Variables are checked with a Zod schema at startup, and a bad value stops the process.

## Owns

- The env schema and the `Env` type, read by `loadEnv` (api, worker, `create-admin`), and the `migrate` entry point's own subset, `MigrateEnv` and `loadMigrateEnv` (only `MIGRATION_DATABASE_URL`, `APP_DB_PASSWORD`, `TENANT_ID`, `APP_DB_ROLE` and `NODE_ENV`, from the same field definitions): [env.ts](env.ts)
- The one staff origin, `staffOrigin(env)`, and `staffBase(env)` (that origin plus `STAFF_BASE_PATH`), which Better Auth, the session guard and the mail links read (spec 0005, AC-30): [env.ts](env.ts)
- The module that provides it through the `ENV` token: [config.module.ts](config.module.ts)

## Never touches

- Other modules' tables or services.
- Per client values baked into code. Client differences live in settings, module toggles or `extensions/<client>`.
- `process.env` outside this folder. Every other file reads config through the injected `ENV` token.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/config
```

The unit spec is [env.spec.ts](env.spec.ts). [compose-env.spec.ts](../../test/compose-env.spec.ts) builds each service's env from `deploy/compose.yaml` (filled from `deploy/.env.example` as `deploy/bootstrap.sh` fills it) and proves the loader its entry point calls accepts it, and that it needs exactly the expected names:

```bash
pnpm --filter @ssdashboard/api exec vitest run test/compose-env
```

## Governing spec

- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)
- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md) (two database roles)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
