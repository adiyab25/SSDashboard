# Shared config (`@ssdashboard/config`)

The configuration every workspace extends: TypeScript presets, ESLint rules, and the logical CSS check.

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- TypeScript presets: [tsconfig/base.json](tsconfig/base.json), [tsconfig/nextjs.json](tsconfig/nextjs.json), [tsconfig/node-library.json](tsconfig/node-library.json), [tsconfig/react-library.json](tsconfig/react-library.json)
- ESLint rules, including the i18n rules: [eslint/](eslint/)
- The personal data redaction list and `redact` function, shared by every log and error sink: [src/redaction.ts](src/redaction.ts). Its key test, [scripts/redaction-keys.test.mjs](scripts/redaction-keys.test.mjs), covers the order, customer, and task keys.
- The logical CSS check that fails `lint` on physical side styles: [scripts/check-logical-css.mjs](scripts/check-logical-css.mjs)
- The commit subject and branch name checks, shared by the `.husky/commit-msg` hook and the CI `conventions` job: [scripts/check-commit-subject.mjs](scripts/check-commit-subject.mjs), [scripts/check-branch-name.mjs](scripts/check-branch-name.mjs)

## Never touches

- Application code or business rules.
- Loosening `strict` or `noUncheckedIndexedAccess` for one workspace without a reason in a comment.
- Per client settings.

## How to test

```bash
pnpm --filter @ssdashboard/config test
```

The redaction function is tested through the api logger, in [apps/api/src/platform/logging/redacting-logger.spec.ts](../../apps/api/src/platform/logging/redacting-logger.spec.ts): `pnpm --filter @ssdashboard/api test -- src/platform/logging`. Its key test, [scripts/redaction-keys.test.mjs](scripts/redaction-keys.test.mjs), runs in this package.

The package `test` script first builds `dist/` (`tsc -p tsconfig.build.json`), because the redaction key test imports `../dist/redaction.js`. Then it runs `node --test` on the redaction key test, on the test file of every check script (for example [scripts/check-logical-css.test.mjs](scripts/check-logical-css.test.mjs)), and on [eslint/i18n.test.mjs](eslint/i18n.test.mjs).

## Governing spec

- [0007 Stack architecture and operations layer](../../docs/specs/0007-stack-architecture-operations-layer/index.md) (personal data redaction, Law 151)
- [0003 Design system and UI foundation](../../docs/specs/0003-design-system-ui-foundation/index.md) (logical CSS)
- [0004 Localization](../../docs/specs/0004-localization/index.md) (i18n lint rules)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
