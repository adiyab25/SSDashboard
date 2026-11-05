import type { TOptions } from 'i18next';
import type { Catalog } from './catalog.js';
import { createI18n } from './create-i18n.js';
import { isCoreLanguage } from './languages.js';
import type { MessageKey } from './message-key.js';
import { directionOf, type TextDirection } from './rtl.js';

/** Translates a catalog key. Plural keys take `count`; other values fill `{{name}}` slots. */
export type TranslateFunction = (key: MessageKey, options?: TOptions) => string;

/** A translator bound to one language: the text function, the language it really speaks, and its direction. */
export interface Translator {
  /** Looks up a key in the language, falling back to English. Never returns a raw key for a real key. */
  t: TranslateFunction;
  /** The language the text is in: the requested one if its catalog was available, else `en`. */
  language: string;
  /** Direction of `language`, so an `<html dir>` or a mail layout always matches the text. */
  dir: TextDirection;
}

/** Catalogs a caller already holds, by language code. English is always built in. */
export type TranslatorCatalogs = Readonly<Record<string, Catalog>>;

/** The base code of a language tag: `AR-EG` becomes `ar`. */
function baseLanguage(language: string): string {
  return language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** Loaded catalogs of the non English core languages, shared by every translator. */
const loaded = new Map<string, Promise<Catalog>>();

/** Loads the catalog of a core language other than English, once. */
function loadCoreCatalog(code: string): Promise<Catalog> | undefined {
  if (code !== 'ar') return undefined;
  let pending = loaded.get(code);
  if (!pending) {
    pending = import('./locales/ar.js').then((module) => module.ar);
    // A failed load is not cached, so the next call can try again.
    pending.catch(() => loaded.delete(code));
    loaded.set(code, pending);
  }
  return pending;
}

/**
 * Builds a translator from catalogs the caller already holds, without any loading. A
 * language with no catalog (and any language but English) speaks English: the returned
 * `language` and `dir` say so, so layout and text always agree.
 */
export function createTranslatorSync(
  language: string,
  catalogs: TranslatorCatalogs = {},
): Translator {
  const requested = baseLanguage(language);
  const catalog = catalogs[requested];
  const effective = requested !== 'en' && catalog ? requested : 'en';
  const instance = createI18n({ language: effective, catalogs });
  return {
    t: (key, options) => instance.t(key, options),
    language: effective,
    dir: directionOf(effective),
  };
}

/**
 * The translator for any language code, for code that has no React: the api's mail, the
 * worker's reports, exports, and receipts. Arabic is loaded by dynamic import the first
 * time and cached. An unknown language, or a key missing from Arabic, gives English and
 * never a raw key. Client languages (extension files) are not served here yet: they get English.
 *
 * Never throws for a bad language code; if the Arabic catalog cannot be loaded it rejects.
 */
export async function createTranslator(language: string): Promise<Translator> {
  const requested = baseLanguage(language);
  if (requested !== 'en' && isCoreLanguage(requested)) {
    const catalog = await loadCoreCatalog(requested);
    if (catalog) return createTranslatorSync(requested, { [requested]: catalog });
  }
  return createTranslatorSync('en');
}
