'use client';

import { useCallback } from 'react';
import { useLanguage } from './language-provider';
import { localizedText, type TextByLanguage } from './localized-text';

/**
 * `localizedText` bound to the active language and the install's order: pass stored
 * `{ en, ar }` text and the code to fall back to.
 */
export function useLocalizedText(): (text: TextByLanguage, code: string) => string {
  const { language, config } = useLanguage();
  const fallback = config?.defaultLanguage ?? 'en';
  const enabled = config?.languages;
  return useCallback(
    (text, code) => localizedText(text, { active: language, fallback, enabled }, code),
    [language, fallback, enabled],
  );
}
