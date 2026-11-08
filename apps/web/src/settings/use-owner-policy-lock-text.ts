'use client';

import type { OwnerPolicyView } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/**
 * Returns a function that says why some fields of an owner type's policy are locked (spec 0009,
 * AC-24, D13), or null when none is. It reads only what the api sends, `lockedFields` and
 * `activeLocations`, never the owner type itself (spec 0002, A13: no code outside the policy
 * service compares owner types): the terms are fixed for the brand's own locations and while a
 * type has open locations, and changed terms mean a new location.
 */
export function useOwnerPolicyLockText(): (
  policy: Pick<OwnerPolicyView, 'lockedFields' | 'activeLocations'>,
) => string | null {
  const { t } = useTranslation();
  const format = useFormat();
  return (policy) =>
    policy.lockedFields.length === 0
      ? null
      : t('settings.ownerPolicies.lockedNote', {
          locations: format.quantity(policy.activeLocations),
        });
}
