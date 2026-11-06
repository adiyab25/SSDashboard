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

## How to test

```bash
pnpm --filter @ssdashboard/i18n test
pnpm --filter @ssdashboard/i18n build
```

The parity test fails the build when an English key is missing from Arabic, or Arabic lacks a plural form its language needs. It walks every key group, so new groups (`mail`, `report`, `export`, `receipt`) are covered the day they are added.

## Governing spec

- [0004 Localization](../../docs/specs/0004-localization/index.md), amendment of 2026-11-05 (AC-14, AC-15, AC-18)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
