/** What the formatters and the switcher need to know about a language. */
export interface LanguageInfo {
  /** The language's own name, shown in the switcher. */
  nativeName: string;
  /** The Intl locale tag. */
  intl: string;
  /** 12 hour clock. Client languages leave it out and follow their Intl tag. */
  hour12?: boolean;
  /** First day of the week, 1 Monday to 7 Sunday. For the first date picker. */
  weekStart: number;
}

/**
 * The core languages shipped with the app. Every formatter adds `numberingSystem: 'latn'`,
 * so digits are Western in all of them.
 */
export const coreLanguages = {
  en: { nativeName: 'English', intl: 'en-GB', hour12: false, weekStart: 1 },
  ar: { nativeName: 'العربية', intl: 'ar-EG', hour12: true, weekStart: 6 },
} as const satisfies Record<string, LanguageInfo>;

export type CoreLanguage = keyof typeof coreLanguages;

export function isCoreLanguage(code: string): code is CoreLanguage {
  return Object.hasOwn(coreLanguages, code);
}
