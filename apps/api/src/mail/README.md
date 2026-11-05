# Mail

Outgoing email for sign in and invites. Messages are queued as pg-boss jobs and sent by the worker over any SMTP server, so it works on premises with no outside service.

## Owns

- The SMTP sender and the `Mailer` interface: [mailer.ts](mailer.ts)
- Queuing messages: [mail-queue.ts](mail-queue.ts)
- The worker that sends them and retries on failure: [mail.worker.ts](mail.worker.ts)
- Message text: [mail-templates.ts](mail-templates.ts)
- Links placed in messages: [mail-links.ts](mail-links.ts)
- Wiring: [mail.module.ts](mail.module.ts), [mail.tokens.ts](mail.tokens.ts)

## Never touches

- Business tables. It sends what it is given.
- Business rules. It queues and sends; the callers decide what to send.
- `process.env`. SMTP settings arrive through the `ENV` token.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/mail
```

Unit specs: [mailer.spec.ts](mailer.spec.ts), [mail.worker.spec.ts](mail.worker.spec.ts), [mail-templates.spec.ts](mail-templates.spec.ts).

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
