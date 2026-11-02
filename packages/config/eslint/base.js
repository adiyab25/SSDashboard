import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Next.js and tool configs need a default export; everything else uses named exports.
export const DEFAULT_EXPORT_FILES = [
  '**/*.config.{js,mjs,ts,mts}',
  '**/*.config.*.{js,mjs,ts,mts}',
  '**/vitest.setup.ts',
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
    { files: ['**/*.js', '**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
    prettier,
  );
}
