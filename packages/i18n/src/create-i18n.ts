import { createInstance, type i18n } from 'i18next';
import type { Catalog } from './catalog.js';
import { en } from './locales/en.js';

/** What `createI18n` can preload besides English. */
export interface CreateI18nOptions {
  /** The active language. Defaults to English. It needs an entry in `catalogs` to differ from English. */
  language?: string;
  /** Catalogs already in hand, by language code. English is always loaded and cannot be replaced. */
  catalogs?: Readonly<Record<string, Catalog>>;
}

/**
 * A fresh i18next instance with English bundled. English is always loaded, so a missing
 * key in any other language falls back to it and a raw key never reaches the screen.
 * It never loads files or fetches anything; callers hand it the catalogs they hold.
 */
export function createI18n(options: CreateI18nOptions = {}): i18n {
  const { language = 'en', catalogs = {} } = options;
  const resources: Record<string, { translation: Catalog }> = {};
  for (const [code, catalog] of Object.entries(catalogs))
    resources[code] = { translation: catalog };
  resources['en'] = { translation: en };

  const instance = createInstance();
  void instance.init({
    lng: language,
    fallbackLng: 'en',
    resources,
    defaultNS: 'translation',
    // Synchronous, so the first render already has English.
    initAsync: false,
    // Callers escape output where it matters (React does; mail templates escape their own).
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}
