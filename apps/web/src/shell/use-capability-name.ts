'use client';

import { MODULE_REGISTRY } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { isolateLtr } from '@/shared/isolate-ltr';

/**
 * Returns a function that names a capability by its key in the active language (the registry's
 * label key), and falls back to the key itself, isolated left to right, for a key this build does
 * not know (an api newer than the web, never a crash).
 */
export function useCapabilityName(): (key: string) => string {
  const { t } = useTranslation();
  return (key) => {
    for (const definition of MODULE_REGISTRY) {
      const found = definition.capabilities.find((capability) => capability.key === key);
      if (found) return t(found.label);
    }
    return isolateLtr(key);
  };
}
