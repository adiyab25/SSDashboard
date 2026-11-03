/** Text stored per language, as in the `{ en, ar }` columns of spec 0002. */
export type TextByLanguage = Readonly<Partial<Record<string, string>>>;

/** Which language's text to prefer, in the order spec 0004 AC-9 sets. */
export interface LanguageOrder {
  active: string;
  /** The install's `default_language`. */
  fallback: string;
  /** Enabled languages in switcher order, for the last resort before the code. */
  enabled?: readonly string[];
}

/**
 * The active language's text, else the install default's, else any other non empty
 * language in enabled order, else the code. Values are trimmed first; blank is empty.
 */
export function localizedText(text: TextByLanguage, order: LanguageOrder, code: string): string {
  const pick = (language: string) => text[language]?.trim() || undefined;
  const others = [...(order.enabled ?? []), ...Object.keys(text)];
  for (const language of [order.active, order.fallback, ...others]) {
    const found = pick(language);
    if (found) return found;
  }
  return code;
}
