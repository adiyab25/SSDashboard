import i18next from 'eslint-plugin-i18next';

const DEFAULT_EXPORT = { selector: 'ExportDefaultDeclaration', message: 'Use a named export.' };

const LOCALE_STRING = {
  selector: 'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]',
  message: 'Format through the shared formatters in src/i18n/format.ts (useFormat).',
};

const INTL_CONSTRUCTOR = {
  selector: "NewExpression[callee.object.name='Intl']",
  message: 'Build Intl formatters only in src/i18n/format.ts; use the formatters from useFormat.',
};

// `Intl.NumberFormat(...)` works without `new`; the static helpers are fine.
const INTL_CALL = {
  selector:
    "CallExpression[callee.object.name='Intl']:not([callee.property.name=/^(getCanonicalLocales|supportedValuesOf)$/])",
  message: 'Build Intl formatters only in src/i18n/format.ts; use the formatters from useFormat.',
};

const FORMATTING_BANS = [LOCALE_STRING, INTL_CONSTRUCTOR, INTL_CALL];

/** Attributes that carry text a person reads or hears. Anything else may hold a literal. */
const TEXT_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];

/**
 * Localization rules for the web app (spec 0004): no raw text in markup, and number, money,
 * and date output only through the shared formatting module. Test specs and e2e files are
 * exempt from both; the `/design` specimens (development only) from the text rule.
 * Pass the workspace's source folder, for example `src`.
 */
export function i18n({ source = 'src', formatModule = 'src/i18n/format.ts' } = {}) {
  const specs = ['**/*.spec.{ts,tsx}', '**/*-test-utils.{ts,tsx}', 'e2e/**'];
  return [
    {
      files: [`${source}/**/*.{ts,tsx}`],
      ignores: [formatModule, ...specs],
      rules: { 'no-restricted-syntax': ['error', DEFAULT_EXPORT, ...FORMATTING_BANS] },
    },
    {
      // App Router special files must default export their component.
      files: [
        `${source}/app/**/{page,layout,template,loading,error,global-error,not-found,default}.tsx`,
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
