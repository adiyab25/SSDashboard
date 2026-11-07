'use client';

import type { Hat } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';

/**
 * The plain names of `hats` in the active language, joined into one line ("Support, Warehouse"),
 * for the user menu and the account screen (spec 0008, AC-11). Names come from the catalog
 * (`access.hats.<hat>.name`), never from the hat codes, so a code never shows to a person.
 */
export function useHatsLabel(hats: readonly Hat[]): string {
  const { t } = useTranslation();
  if (hats.length === 0) return t('access.hats.none');
  return hats.map((hat) => t(`access.hats.${hat}.name`)).join(t('access.hats.separator'));
}
