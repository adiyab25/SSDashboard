/** Languages written right to left, by base code. */
export const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb'] as const;

/** The two text directions. */
export type TextDirection = 'ltr' | 'rtl';

/** The text direction of a language code; unknown codes read left to right. */
export function directionOf(code: string): TextDirection {
  return (RTL_LANGUAGES as readonly string[]).includes(code) ? 'rtl' : 'ltr';
}
