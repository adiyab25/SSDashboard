import { pluralCategories } from './format';
import { en } from './locales/en';

/** A translation catalog: nested objects whose leaves are strings. */
export interface Catalog {
  [key: string]: string | Catalog;
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** `{ a: { b: 'x' } }` becomes `{ 'a.b': 'x' }`. Anything that is not a string is dropped. */
export function flatten(catalog: object, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(catalog as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') flat[path] = value;
    else if (value && typeof value === 'object') Object.assign(flat, flatten(value, path));
  }
  return flat;
}

/** The key without its plural suffix: `shell.locations.count_one` is `shell.locations.count`. */
export function baseKey(key: string): string {
  return key.replace(PLURAL_SUFFIX, '');
}

/** English keys, flattened. The source of truth for what every other language must have. */
export const englishKeys: readonly string[] = Object.keys(flatten(en));

/** Plural bases in English (keys written with `_one` and `_other`). */
export const pluralBases: ReadonlySet<string> = new Set(
  englishKeys.filter((key) => PLURAL_SUFFIX.test(key)).map(baseKey),
);

/** Non plural keys in English, as written. */
const plainKeys: ReadonlySet<string> = new Set(
  englishKeys.filter((key) => !PLURAL_SUFFIX.test(key)),
);

/**
 * What a client language file may contribute: only keys English has (plural keys by their
 * base, so a language may use plural forms English lacks), and only string values. Flat
 * dotted keys, the form i18next resolves for both flat and nested files.
 */
export function pickKnownKeys(raw: object): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(flatten(raw))) {
    if (key.startsWith('_meta.')) continue;
    if (plainKeys.has(key) || pluralBases.has(baseKey(key))) picked[key] = value;
  }
  return picked;
}

/** Every key a complete catalog for this Intl tag must have. */
export function requiredKeys(intlTag: string): string[] {
  const forms = pluralCategories(intlTag);
  const keys = englishKeys.filter((key) => !PLURAL_SUFFIX.test(key));
  for (const base of pluralBases) for (const form of forms) keys.push(`${base}_${form}`);
  return keys;
}
