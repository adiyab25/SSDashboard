'use client';

import type { MessageKey } from '@ssdashboard/i18n';
import { useTranslation } from 'react-i18next';
import { isolateLtr } from '@/shared/isolate-ltr';

/**
 * Returns a function that names a module by its key in the active language (`modules.<key>.label`,
 * spec 0009, AC-6), and falls back to the key itself for a module this build's catalog does not
 * know (an api newer than the web, never a crash).
 */
export function useModuleLabel(): (key: string) => string {
  const { t, i18n } = useTranslation();
  return (key) => {
    const messageKey = `modules.${key}.label`;
    return i18n.exists(messageKey) ? t(messageKey as MessageKey) : isolateLtr(key);
  };
}
