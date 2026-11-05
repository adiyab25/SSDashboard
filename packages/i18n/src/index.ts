import './i18next-types.js';
export {
  baseKey,
  englishKeys,
  flatten,
  pickKnownKeys,
  pluralBases,
  requiredKeys,
} from './catalog.js';
export type { Catalog } from './catalog.js';
export { createI18n } from './create-i18n.js';
export type { CreateI18nOptions } from './create-i18n.js';
export { CORE_LANGUAGES, isCoreLanguage } from './languages.js';
export type { CoreLanguage, LanguageInfo } from './languages.js';
export { en } from './locales/en.js';
export type { MessageKey } from './message-key.js';
export { pluralCategories } from './plural-categories.js';
export { directionOf, RTL_LANGUAGES } from './rtl.js';
export type { TextDirection } from './rtl.js';
export { createTranslator, createTranslatorSync } from './translator.js';
export type { TranslateFunction, Translator, TranslatorCatalogs } from './translator.js';
