/**
 * The plural forms a language needs (`one`, `few`, ...), from `Intl.PluralRules` and never
 * hand written. The catalog parity check uses it, so Arabic must carry all six forms.
 */
export function pluralCategories(intl: string): readonly string[] {
  return new Intl.PluralRules(intl).resolvedOptions().pluralCategories;
}
