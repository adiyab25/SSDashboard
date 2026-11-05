# Language and formatting

English and Arabic in the browser: the language provider, the cookie and head script, and the only place numbers, money and dates are formatted. The message catalogs, typed keys, language registry, and translator live in [packages/i18n](../../../../packages/i18n/README.md).

## Owns

- The active language, direction and cookie: [language-provider.tsx](language-provider.tsx), [language-config.ts](language-config.ts) (cookie and head script), [language-cookie.ts](language-cookie.ts)
- Number, quantity, percent, money and date formatters: [format.ts](format.ts), [use-format.ts](use-format.ts)
- Which language to show for stored `{ en, ar }` text: [localized-text.ts](localized-text.ts), [use-localized-text.ts](use-localized-text.ts)
- Client language files loaded at runtime: [runtime-languages.ts](runtime-languages.ts)

## Never touches

- Business data or api calls.
- `Intl` anywhere else. `lint` fails on `toLocaleString` and `new Intl.*` outside `format.ts`.
- Cookies read on the server. The server markup is always English left to right; the saved language applies after hydration.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/i18n
pnpm --filter @ssdashboard/web test:e2e -- e2e/localization.spec.ts
```

Another Playwright spec: `e2e/bilingual-location.spec.ts`.

## Governing spec

- [0004 Localization](../../../../docs/specs/0004-localization/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
