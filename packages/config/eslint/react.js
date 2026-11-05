import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactPlugin from 'eslint-plugin-react';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base, TSDOC_EXEMPT_FILES } from './base.js';

/** Rules for React packages outside Next.js: the shared base plus accessibility checks. */
export function react(tsconfigRootDir) {
  return tseslint.config(
    ...base(tsconfigRootDir),
    { files: ['**/*.{jsx,tsx}'], ...jsxA11y.flatConfigs.recommended },
    { languageOptions: { globals: globals.browser } },
    {
      // Spec 0007: one component per file. Exempt: shadcn compound components in
      // packages/ui/src/components (this config is only used by packages/ui), see
      // docs/adr/0001-shadcn-component-files-keep-their-vendor-shape.md.
      files: ['**/*.tsx'],
      ignores: [...TSDOC_EXEMPT_FILES, 'src/components/**'],
      plugins: { react: reactPlugin },
      settings: { react: { version: 'detect' } },
      rules: { 'react/no-multi-comp': 'error' },
    },
  );
}
