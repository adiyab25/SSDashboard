# Extension loader

Loads the per client extension packages named in the `EXTENSIONS` setting. Today it only proves each listed package can be imported. The hook contract extensions must follow is not decided yet (see the comment in [load-extensions.ts](load-extensions.ts)).

## Owns

- Loading extensions by dynamic `import()`: [load-extensions.ts](load-extensions.ts)

## Never touches

- Extension code by static import. The core never imports an extension.
- Core tables. Extensions keep their own tables in their own schema.
- Core tables, the ledger's included. [../module-boundary.spec.ts](../module-boundary.spec.ts) fails if an extension names one.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/extensions
```

The unit spec is [load-extensions.spec.ts](load-extensions.spec.ts).

## Governing spec

- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)
- How a client extension is laid out: [extensions/README.md](../../../../extensions/README.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
