import { createInstance, type i18n } from 'i18next';
import { en } from './locales/en';

/**
 * A fresh i18next instance with English bundled. English is always loaded, so a missing
 * key in any other language falls back to it and a raw key never reaches the screen.
 */
export function createI18n(): i18n {
  const instance = createInstance();
  void instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    defaultNS: 'translation',
    // Synchronous, so the first render already has English.
    initAsync: false,
    // React escapes output, and catalogs are never rendered as HTML.
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}
