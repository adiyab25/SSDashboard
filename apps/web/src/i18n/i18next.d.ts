import type { en } from './locales/en';

// Makes `t('some.key')` check the key against the English catalog: a wrong key fails tsc.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
