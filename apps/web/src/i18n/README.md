# Language and formatting

English and Arabic in the browser: the language provider, the cookie and head script, and the hook that formats numbers, money and dates with the install's settings (the formatters themselves are `createFormatter` in the package). The message catalogs, typed keys, language registry, and translator live in [packages/i18n](../../../../packages/i18n/README.md).

## Owns

- The active language, direction and cookie: [language-provider.tsx](language-provider.tsx), [language-config.ts](language-config.ts) (cookie and head script), [language-cookie.ts](language-cookie.ts)
- The formatting hook, `createFormatter` plus the settings from `/api/config` and a loading or error `status`: [use-format.ts](use-format.ts)
- Which language to show for stored `{ en, ar }` text: [localized-text.ts](localized-text.ts), [use-localized-text.ts](use-localized-text.ts)
- Client language files loaded at runtime: [runtime-languages.ts](runtime-languages.ts)
- The portal and partner audiences (language in the URL, spec 0004 AC-16): [public-language.ts](public-language.ts) (the two served languages, matching a URL segment), [choose-public-language.ts](choose-public-language.ts) (cookie, then `Accept-Language`, then Arabic, used by the proxy), [page-language.ts](page-language.ts) (`lang` root parameter, 404 otherwise), [other-language-link.tsx](other-language-link.tsx) (the plain link to the other language)

Client languages (runtime files) apply to the back office only (spec 0004, AC-23). The portal and partner pages serve only `en` and `ar`: a saved `ss_lang` that is a valid but non core code (such as a client's `fr`) sends an unprefixed portal or partner link to `/en`, a prefixed path never overwrites that cookie, and a user whose saved language is a client language gets English there until a server side loader exists.

## Never touches

- Business data or api calls.
- `Intl` anywhere. `lint` fails on `toLocale*String` and `Intl.*` formatters outside `packages/i18n/src`; use `createFormatter`.
- Cookies read on the server, except in the proxy, which only picks the redirect for a portal or partner path. For the back office and sign in the server markup is always English left to right and the saved language applies after hydration; the portal and partner pages get their language from the URL, and `LanguageProvider` starts in it (`initial`) without swapping or saving anything.

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
