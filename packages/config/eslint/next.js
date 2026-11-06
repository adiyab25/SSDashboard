import nextVitals from 'eslint-config-next/core-web-vitals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base, TSDOC_EXEMPT_FILES } from './base.js';

/** Rules for the Next.js app: the shared base plus Next, React, and accessibility checks. */
export function next(tsconfigRootDir) {
  return tseslint.config(
    // Next first, so the shared base (its parser and type aware settings) wins.
    ...nextVitals,
    ...base(tsconfigRootDir),
    // Next registers the jsx-a11y plugin; turn on its full recommended rule set.
    { files: ['**/*.{jsx,tsx}'], rules: jsxA11y.flatConfigs.recommended.rules },
    { languageOptions: { globals: globals.browser } },
    {
      // Spec 0007: one component per file. Next already registers the react plugin.
      files: ['**/*.tsx'],
      ignores: TSDOC_EXEMPT_FILES,
      rules: { 'react/no-multi-comp': 'error' },
    },
    {
      // App Router special files must default export their component.
      files: [
        'src/app/**/{page,layout,template,loading,error,global-error,global-not-found,not-found,default}.tsx',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
  );
}
