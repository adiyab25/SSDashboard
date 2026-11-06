# packages/config

## Overview

Shared configuration every workspace extends: TypeScript presets, ESLint rules, the personal data redaction list, and the repo check scripts run by `lint` and CI. Prettier config is the root `.prettierrc.json`, not here.

## Key files

| File | Owns |
|---|---|
| `tsconfig/base.json` | Strict compiler options every preset inherits |
| `tsconfig/nextjs.json` | Preset for `apps/web` |
| `tsconfig/node-library.json` | Preset for the packages |
| `tsconfig/react-library.json` | Preset for React packages outside Next.js (`packages/ui`) |
| `eslint/base.js` | Shared rules for every workspace, including the spec 0007 conventions: `jsdoc/require-jsdoc` (`REQUIRE_JSDOC`, publicOnly, no fixer) and `tsdoc/syntax` on `.ts`/`.tsx`, and `unicorn/filename-case` (kebab case, `[param]` and `(group)` names kept). `TSDOC_EXEMPT_FILES` (specs, `*.test-support.ts(x)` (the deliberate home of test helpers: the word `utils` is banned, so name them `<thing>.test-support.ts`), `e2e/`, `__fixtures__/`, `.d.ts`, `*.config.ts`, `vitest.setup.ts`) skips TSDoc and the one component rule |
| `eslint/react.js`, `eslint/next.js` | ESLint for React packages and the Next app: the base rules plus jsx-a11y and `react/no-multi-comp` (one component per `.tsx` file; `packages/ui/src/components/**` exempt by ADR 0001) |
| `eslint/i18n.js` | `i18n()` for the web (no raw text in JSX or labelling attributes, plus the formatting ban) and `formattingBan()` for the api, the worker and `packages/i18n` (no `toLocale*` or `Intl.*` formatters outside `packages/i18n/src/format.ts` and `plural-categories.ts`) |
| `src/redaction.ts` | The personal data redaction list, `ROW_MARKER_RULES` (a bare `name`, `reason`, or `payload` is redacted only on a row that one table's own keys identify), and the pure `redact` function (Law 151, spec 0007); built to `dist/`, imported as `@ssdashboard/config/redaction` by the api logger and later by pino and the error tracker |
| `scripts/check-logical-css.mjs` | Fails `lint` on physical side styles in `packages/ui` and `apps/web` (spec 0003); its tests and planted fixtures sit beside it |
| `scripts/check-module-readmes.mjs` | Fails `lint` when an api module, web feature folder, or package lacks a README with the five headings of `docs/templates/module-readme.md` (spec 0007) |
| `scripts/check-route-groups.mjs` | Fails `lint` on any top level route group in `apps/web/src/app` other than `(backoffice)`, `(portal)`, `(partner)`, `(auth)` |
| `scripts/check-folder-names.mjs` | Fails `lint` on global `services` or `controllers` folders (folder by feature) |
| `scripts/check-tsdoc-fixture.mjs` | Fails `lint` unless `jsdoc/require-jsdoc` reports every export kind (function, class, method, interface, type alias, enum, exported const, React component, hook) in `scripts/fixtures/tsdoc/`; `--without-require-jsdoc` shows it failing |
| `scripts/check-banned-names.mjs` | Fails `lint` on a file or folder name with a banned whole word (`mgr`, `cfg`, `util`, `utils`, `misc`, `temp`, `tmp`, `stuff`, `helper`, `helpers`) in `apps/*`, `packages/*`, `extensions/*` |
| `scripts/check-component-export-names.mjs` | Fails `lint` when a `.tsx` file in `apps/web/src` or `packages/ui/src` that exports a PascalCase value does not export the one named after the file (`exchange-request-form.tsx` exports `ExchangeRequestForm`); Next special files, specs, and test utilities are skipped |
| `scripts/check-doc-links.mjs` | Fails `lint` on a relative link in `docs/**`, a README, or an AGENTS.md that does not resolve |
| `scripts/check-commit-subject.mjs` | The shared commit subject check: rejects banned whole subjects (`wip`, `misc`, `fixes`, ...), conventional prefixes (`feat:`), `fixup!`/`squash!`, and subjects over 72 characters; allows GitHub merge commits. Run by `.husky/commit-msg` on a message file and by the CI `conventions` job with `--range base..head` |
| `scripts/check-branch-name.mjs` | Fails unless a branch is `feat/`, `fix/`, or `docs/` plus a kebab case slug; the CI `conventions` job passes the pull request head branch |

## Commands

```bash
pnpm --filter @ssdashboard/config test   # every check script's own tests (node --test)
pnpm lint:repo                           # the repo wide checks; `pnpm lint` runs them through the root task //#lint:repo
```

## Conventions

- Emptying or trimming `PERSONAL_DATA_KEYS` in `src/redaction.ts` leaks customer data into logs. Its tests are `apps/api/src/platform/logging/redacting-logger.spec.ts` and `scripts/redaction-keys.test.mjs` (the order, customer, and task keys). The key test imports `../dist/redaction.js`, so run `pnpm --filter @ssdashboard/config test`, which builds first. Build this package (`pnpm --filter @ssdashboard/config build`) before testing the api against a changed list.
- Loosening an option here loosens it everywhere. Keep `strict` and `noUncheckedIndexedAccess` on; override per workspace only with a reason in a comment.
- A line the logical CSS check must skip carries `logical-css-ignore: <reason>` on it or the line above; `ltr:` and `rtl:` scoped utilities are always allowed.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
