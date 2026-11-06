import type { en } from './locales/en.js';

// Makes `t('some.key')` check the key against the English catalog in every workspace that
// imports this package: a wrong key fails tsc. Declared once, here, and nowhere else.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
