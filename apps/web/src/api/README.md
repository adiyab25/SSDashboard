# Api client

The shared way the web calls the api: `ApiError` with the stable error `code`, built on `apiFetch`.

## Owns

- `ApiError` and the error body shape: [client.ts](client.ts)

## Never touches

- Business rules. It carries requests and errors only.
- Absolute api URLs. Calls use relative `/api` paths.
- Hand written copies of request or response shapes. Shapes come from `@ssdashboard/contracts`.

## How to test

```bash
pnpm --filter @ssdashboard/web test
```

This folder has no spec of its own. Its sibling [../auth/api-fetch.spec.ts](../auth/api-fetch.spec.ts) covers `apiFetch`, and the feature specs exercise `ApiError`.

## Governing spec

- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
