import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base } from './base.js';

/** Rules for React packages outside Next.js: the shared base plus accessibility checks. */
export function react(tsconfigRootDir) {
  return tseslint.config(
    ...base(tsconfigRootDir),
    { files: ['**/*.{jsx,tsx}'], ...jsxA11y.flatConfigs.recommended },
    { languageOptions: { globals: globals.browser } },
  );
}
