# Language and shared text (`@ssdashboard/i18n`)

The one source of every translated string, the language registry, and the translator that the web, the api's mail, and the worker all read, so English and Arabic text cannot drift apart.

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- The message catalogs: [English](src/locales/en.ts) (the source, the type source, and the fallback) and [Arabic](src/locales/ar.ts) (`@ssdashboard/i18n/ar`, a separate entry so the web keeps it a lazy chunk)
- The typed key list: [message-key.ts](src/message-key.ts), [i18next-types.ts](src/i18next-types.ts)
- The language registry and direction: [languages.ts](src/languages.ts), [rtl.ts](src/rtl.ts)
- Catalog checks used by the parity test and by client language files: [catalog.ts](src/catalog.ts), [plural-categories.ts](src/plural-categories.ts)
- The formatters: [format.ts](src/format.ts) (`createFormatter`: number, quantity, percent, money, date, dateNumeric, dateOnly, time, dateTime in the install's currency and time zone, Western digits), and the only other `Intl` user, [plural-categories.ts](src/plural-categories.ts)
- The translators: [translator.ts](src/translator.ts) (`createTranslator`, `createTranslatorSync`), [create-i18n.ts](src/create-i18n.ts)
- The digit parsers: [digits.ts](src/digits.ts) (`normalizeDigits`, `parseQuantity`, `parseMoney`, `InvalidDigitInputError`), used by the Zod helpers in `packages/contracts` (AC-18)

## Never touches

- React, `react-i18next`, cookies, the browser, or `fetch`. It depends on `i18next` only.
- Business data or api calls.
- The language cookie and head script, the provider, and client language files: those stay in `apps/web/src/i18n/`.

Only the core languages, `en` and `ar`, live here. Client languages (`extensions/<client>/locales/<code>.json`) apply to the back office only; portal and partner pages, mail, the report, and exports use `en` and `ar`, and a user whose saved language is a client language gets English there until a server side loader exists (spec 0004, AC-23).

## How to test

```bash
pnpm --filter @ssdashboard/i18n test
pnpm --filter @ssdashboard/i18n build
```

The parity test fails the build when an English key is missing from Arabic, or Arabic lacks a plural form its language needs. It walks every key group, so new groups (`mail`, `report`, `export`, `receipt`) are covered the day they are added.

## Release step: time zone data

Node, PostgreSQL, and each image carry their own copy of the time zone data, and Egypt can change its daylight saving rule at short notice. `pnpm check:timezone` (root script, [check-timezone.mjs](../config/scripts/check-timezone.mjs)) is the named release step for the feature 26 runbook. In order:

1. Rebuild both images (`app` and `web`) from a current Node base image, and pull a current PostgreSQL 18 patch release.
2. Run `pnpm check:timezone` against that database. It prints `process.versions.tz` and `process.versions.icu`, the `NODE_VERSION` build argument of `deploy/Dockerfile.app` and `deploy/Dockerfile.web` (it fails if they differ), and the PostgreSQL `server_version`, then runs the operating day test [operating-day-dst.e2e-spec.ts](../db/test/operating-day-dst.e2e-spec.ts) (AC-21).
3. If it exits non zero, do not tag the release. The test fails when PostgreSQL and Node disagree about a Cairo transition, or when a year does not have exactly two offset changes.

The `tz` and `icu` it prints come from the Node that runs the check, not from the image. The feature 26 runbook must run it on Node 26 (the image's version, `NODE_VERSION` in the Dockerfiles); a developer machine on another Node (for example 22) prints that Node's data.

It needs Postgres (`MIGRATION_DATABASE_URL` or `DATABASE_URL` from `.env`) and checks 2026 plus the current UTC year.

## Governing spec

- [0004 Localization](../../docs/specs/0004-localization/index.md), amendment of 2026-11-05 (AC-14, AC-15, AC-18, AC-19, AC-20, AC-21, AC-22)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
