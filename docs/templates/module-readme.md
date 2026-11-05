# Module name in business words

One sentence: what this module is for, in the business's words.

## Owns

The tables, services, screens, and events this module is the only writer or owner of.

## Never touches

What this module must not read or write: other modules' tables, the ledger, the owner database role.
It talks to other modules only through their exported services or past tense domain events.

## How to test

The exact commands, for example `pnpm --filter @ssdashboard/api test`, and what needs a database.

## Governing spec

Links to the spec section and scope feature that define this module, with relative paths.

## Decisions

Links to the ADRs in `docs/adr/` that govern this module, or "None yet."
