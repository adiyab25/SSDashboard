import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import jsdoc from 'eslint-plugin-jsdoc';
import tsdoc from 'eslint-plugin-tsdoc';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Next.js and tool configs need a default export; everything else uses named exports.
export const DEFAULT_EXPORT_FILES = [
  '**/*.config.{js,mjs,ts,mts}',
  '**/*.config.*.{js,mjs,ts,mts}',
  '**/vitest.setup.ts',
];

/**
 * Files that need no TSDoc and may hold several components: tests, end to end specs, test
 * fixtures, declaration files, and tool configs (which Next, Vitest, Playwright, Drizzle, and
 * ESLint load by name).
 */
export const TSDOC_EXEMPT_FILES = [
  '**/*.{spec,test}.{ts,tsx}',
  '**/*.test-support.{ts,tsx}',
  '**/e2e/**',
  '**/__fixtures__/**',
  '**/*.d.ts',
  '**/*.config.{ts,mts}',
  '**/*.config.*.{ts,mts}',
  '**/vitest.setup.ts',
];

/**
 * The `jsdoc/require-jsdoc` options of spec 0007 (Conventions): every exported function,
 * class, method, interface, type alias, enum, and exported constant needs a TSDoc comment.
 * `enableFixer: false` so an empty stub comment never satisfies the rule.
 */
export const REQUIRE_JSDOC = [
  'error',
  {
    publicOnly: true,
    require: {
      FunctionDeclaration: true,
      ClassDeclaration: true,
      ArrowFunctionExpression: true,
      FunctionExpression: true,
      MethodDefinition: true,
    },
    contexts: [
      'TSInterfaceDeclaration',
      'TSTypeAliasDeclaration',
      'TSEnumDeclaration',
      'ExportNamedDeclaration > VariableDeclaration',
    ],
    enableFixer: false,
  },
];

/** Shared rules for every workspace. Pass the workspace folder as `tsconfigRootDir`. */
export function base(tsconfigRootDir) {
  return tseslint.config(
    {
      ignores: [
        '**/dist/**',
        '**/.next/**',
        '**/coverage/**',
        '**/test-results/**',
        'next-env.d.ts',
      ],
    },
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        globals: globals.node,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        'no-restricted-syntax': [
          'error',
          { selector: 'ExportDefaultDeclaration', message: 'Use a named export.' },
        ],
      },
    },
    { files: DEFAULT_EXPORT_FILES, rules: { 'no-restricted-syntax': 'off' } },
    {
      // Spec 0007: kebab case file names. Next's `[param]` files and `(group)` names are kept.
      plugins: { unicorn },
      rules: {
        'unicorn/filename-case': ['error', { case: 'kebabCase', ignore: [/^\[.+\]/, /^\(.+\)/] }],
      },
    },
    {
      // Spec 0007: TSDoc on every export, written in valid TSDoc.
      files: ['**/*.{ts,tsx}'],
      ignores: TSDOC_EXEMPT_FILES,
      plugins: { jsdoc, tsdoc },
      rules: { 'jsdoc/require-jsdoc': REQUIRE_JSDOC, 'tsdoc/syntax': 'error' },
    },
    { files: ['**/*.js', '**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
    prettier,
  );
}
