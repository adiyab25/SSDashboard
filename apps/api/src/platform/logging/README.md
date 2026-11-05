# Logging

The redacting logger every api and worker log line passes through, so personal data of customers never reaches a log (Law 151).

## Owns

- The Nest logger that redacts each argument before printing: [redacting-logger.ts](redacting-logger.ts)
- The test that logs a fixture order and asserts no phone, name, or address survives: [redacting-logger.spec.ts](redacting-logger.spec.ts)

## Never touches

- The redaction list and the `redact` function. They live in [packages/config](../../../../../packages/config/src/redaction.ts) so the error tracker and a future pino logger share them.
- Business rules or any module's tables.
- Log shipping, levels per environment, or the error tracker (later observability feature).

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/platform/logging
```

## Governing spec

- [0007 Stack architecture and operations layer](../../../../../docs/specs/0007-stack-architecture-operations-layer/index.md), "Personal data in logs and errors (Law 151)"

## Decisions

- Staff emails stay loggable for audit; only customer emails are redacted (by path). The auth logger already reduces failed queries to a pg code, so it needs no change.
- Phones in free text are masked by shape; names and addresses are removed by field, so personal text must travel in a named field.
