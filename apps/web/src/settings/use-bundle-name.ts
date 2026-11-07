'use client';

import type { LicenseBundle } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';

/** The name of one plan as the person reads it, in the active language. */
export function useBundleName(): (bundle: LicenseBundle | 'core') => string {
  const { t } = useTranslation();
  return (bundle) => t(`settings.license.bundles.${bundle}`);
}
