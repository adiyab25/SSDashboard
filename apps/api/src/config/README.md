# Configuration

The one place the api reads its environment. Variables are checked with a Zod schema at startup, and a bad value stops the process.

## Owns

- The env schema and the `Env` type: [env.ts](env.ts)
- The module that provides it through the `ENV` token: [config.module.ts](config.module.ts)

## Never touches

- Other modules' tables or services.
- Per client values baked into code. Client differences live in settings, module toggles or `extensions/<client>`.
- `process.env` outside this folder. Every other file reads config through the injected `ENV` token.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/config
```

The unit spec is [env.spec.ts](env.spec.ts).

## Governing spec

- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)
- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md) (two database roles)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
