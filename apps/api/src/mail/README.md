# Mail

Outgoing email for sign in and invites. Messages are queued as pg-boss jobs and sent by the worker over any SMTP server, so it works on premises with no outside service.

## Owns

- The SMTP sender and the `Mailer` interface: [mailer.ts](mailer.ts)
- Queuing messages: [mail-queue.ts](mail-queue.ts)
- The worker that sends them and retries on failure: [mail.worker.ts](mail.worker.ts)
- Message layout: [mail-templates.ts](mail-templates.ts). The words are the `mail.*` keys of the shared catalog (`packages/i18n`, English and Arabic); there is no copy table here
- Links placed in messages: [mail-links.ts](mail-links.ts), always `PUBLIC_URL` plus `STAFF_BASE_PATH` plus the route
- Wiring: [mail.module.ts](mail.module.ts), [mail.tokens.ts](mail.tokens.ts)

## Never touches

- Business tables. It sends what it is given.
- The auth tables (`users`, `verifications`). The worker reads the recipient and the token row through identity's [MailRecipients](../identity/sign-in/mail-recipients.ts) (spec 0005, AC-27).
- Business rules. It queues and sends; the callers decide what to send.
- `process.env`. SMTP settings arrive through the `ENV` token.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/mail
```

Unit specs: [mailer.spec.ts](mailer.spec.ts), [mail.worker.spec.ts](mail.worker.spec.ts), [mail-templates.spec.ts](mail-templates.spec.ts), the pinned output [mail-templates.snapshot.spec.ts](mail-templates.snapshot.spec.ts) (never update it with `-u` for a wording change by accident), and the wrong key type fixture [mail-keys.typecheck.spec.ts](mail-keys.typecheck.spec.ts).

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)
- [0004 Localization](../../../../docs/specs/0004-localization/index.md) (the message words, AC-15)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
