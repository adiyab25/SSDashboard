# packages/i18n

## Overview

The shared message catalogs, language registry, and translator, used by the web, the api (mail), and the worker. See [README.md](README.md) and [spec 0004](../../docs/specs/0004-localization/index.md).

## Stack

TypeScript and `i18next` (`catalog:` version). Built to `dist/` with `tsc`; consumers import the built output, so build before typechecking dependents (Turborepo handles this).

## Commands

```bash
pnpm --filter @ssdashboard/i18n build
pnpm --filter @ssdashboard/i18n test   # src/*.spec.ts
```

## Conventions

- English (`src/locales/en.ts`) is the source, the type source, and the fallback. Every key needs an Arabic one in `src/locales/ar.ts`; a plural key needs every form Arabic uses. The parity test fails otherwise.
- ESM with NodeNext resolution: relative imports need the `.js` suffix. It must run in plain Node, not only in a bundler.
- Never import `ar` from the main entry. It is `@ssdashboard/i18n/ar` (and the dynamic import inside `createTranslator` goes through `./ar.js`, the same module, so the bundler emits one Arabic chunk) so the web keeps it a lazy chunk.
- No React, no `react-i18next`, no cookies, no `fetch`.
- The `t` of a translator is typed by `MessageKey`; the key type comes from one `declare module 'i18next'` in `src/i18next-types.ts`. Do not declare it again in a consumer.
- The digit parsers (`src/digits.ts`) are pure and never applied to passwords, names, or free text.
- `createFormatter` (`src/format.ts`) and `src/plural-categories.ts` are the only files that build `Intl` objects; `lint` bans `toLocale*` and `Intl.*` formatters everywhere else, in the web, the api and the worker too. Keep Intl options fixed (`numberingSystem: 'latn'`) so every process prints the same text.
