# Shared config (`@ssdashboard/config`)

The configuration every workspace extends: TypeScript presets, ESLint rules, and the logical CSS check.

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- TypeScript presets: [tsconfig/base.json](tsconfig/base.json), [tsconfig/nextjs.json](tsconfig/nextjs.json), [tsconfig/node-library.json](tsconfig/node-library.json), [tsconfig/react-library.json](tsconfig/react-library.json)
- ESLint rules, including the i18n rules: [eslint/](eslint/)
- The logical CSS check that fails `lint` on physical side styles: [scripts/check-logical-css.mjs](scripts/check-logical-css.mjs)

## Never touches

- Application code or business rules.
- Loosening `strict` or `noUncheckedIndexedAccess` for one workspace without a reason in a comment.
- Per client settings.

## How to test

```bash
pnpm --filter @ssdashboard/config test
```

This runs `node --test` on [scripts/check-logical-css.test.mjs](scripts/check-logical-css.test.mjs) and [eslint/i18n.test.mjs](eslint/i18n.test.mjs).

## Governing spec

- [0003 Design system and UI foundation](../../docs/specs/0003-design-system-ui-foundation/index.md) (logical CSS)
- [0004 Localization](../../docs/specs/0004-localization/index.md) (i18n lint rules)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
