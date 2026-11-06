import i18next from 'eslint-plugin-i18next';

const DEFAULT_EXPORT = { selector: 'ExportDefaultDeclaration', message: 'Use a named export.' };

const LOCALE_STRING = {
  selector: 'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]',
  message: 'Format through createFormatter from @ssdashboard/i18n (useFormat in the web).',
};

const INTL_CONSTRUCTOR = {
  selector: "NewExpression[callee.object.name='Intl']",
  message:
    'Build Intl formatters only in packages/i18n/src; use createFormatter from @ssdashboard/i18n (useFormat in the web).',
};

// `Intl.NumberFormat(...)` works without `new`; the static helpers are fine.
const INTL_CALL = {
  selector:
    "CallExpression[callee.object.name='Intl']:not([callee.property.name=/^(getCanonicalLocales|supportedValuesOf)$/])",
  message:
    'Build Intl formatters only in packages/i18n/src; use createFormatter from @ssdashboard/i18n (useFormat in the web).',
};

/** The `no-restricted-syntax` selectors of the formatting ban, for configs that merge their own. */
export const FORMATTING_BANS = [LOCALE_STRING, INTL_CONSTRUCTOR, INTL_CALL];

/** Attributes that carry text a person reads or hears. Anything else may hold a literal. */
const TEXT_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];

const SPECS = ['**/*.spec.{ts,tsx}', '**/*.test-support.{ts,tsx}', 'e2e/**', 'test/**'];

/**
 * The formatting ban alone, for workspaces without JSX (the api and the worker): no
 * `toLocale*String` and no `Intl.*` formatter outside `packages/i18n/src/`, where
 * `createFormatter` lives. Test specs and e2e files are exempt. Only `packages/i18n` passes
 * `exempt` (its own files that build `Intl` objects); every other workspace passes nothing.
 * Pass the workspace's source folder, for example `src`.
 */
export function formattingBan({ source = 'src', exempt = [] } = {}) {
  return [
    {
      files: [`${source}/**/*.ts`],
      ignores: [...SPECS, ...exempt],
      rules: { 'no-restricted-syntax': ['error', ...FORMATTING_BANS] },
    },
  ];
}

/**
 * Localization rules for the web app (spec 0004): no raw text in markup, and number, money,
 * and date output only through `createFormatter` (`@ssdashboard/i18n`, `useFormat` in the
 * web). Test specs and e2e files are exempt from both; the `/design` specimens (development
 * only) from the text rule. Pass the workspace's source folder, for example `src`.
 */
export function i18n({ source = 'src', exempt = [] } = {}) {
  const specs = SPECS;
  return [
    {
      files: [`${source}/**/*.{ts,tsx}`],
      ignores: [...specs, ...exempt],
      rules: { 'no-restricted-syntax': ['error', DEFAULT_EXPORT, ...FORMATTING_BANS] },
    },
    {
      // App Router special files must default export their component.
      files: [
        `${source}/app/**/{page,layout,template,loading,error,global-error,global-not-found,not-found,default}.tsx`,
      ],
      ignores: specs,
      rules: { 'no-restricted-syntax': ['error', ...FORMATTING_BANS] },
    },
    {
      files: [`${source}/**/*.tsx`],
      ignores: [`${source}/design/**`, ...specs],
      plugins: { i18next },
      rules: {
        'i18next/no-literal-string': [
          'error',
          {
            mode: 'jsx-only',
            'jsx-attributes': { include: TEXT_ATTRIBUTES },
          },
        ],
      },
    },
  ];
}
