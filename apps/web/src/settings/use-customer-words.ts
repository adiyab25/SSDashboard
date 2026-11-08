'use client';

import type { SettingStepView } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';

/**
 * Returns a function that says whether the customer hears about what an executing step does
 * (spec 0009, AC-21, AC-25, D10), from its `notifiesCustomer`: yes; or, for a step whose capability
 * writes to Shopify, that Shopify will not email the customer; or that the customer is not
 * messaged because of it. It reads only the flag the registry declares, never decides it.
 */
export function useCustomerWords(): (
  step: Pick<SettingStepView, 'capability' | 'notifiesCustomer'>,
) => string {
  const { t } = useTranslation();
  return (step) =>
    step.notifiesCustomer
      ? t('settings.automations.customerHears')
      : step.capability.startsWith('connectors.shopify.')
        ? t('settings.automations.customerShopify')
        : t('settings.automations.customerNotHears');
}
