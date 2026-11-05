'use client';

import { useTranslation } from 'react-i18next';

/** The part of a Better Auth error the message depends on. */
interface ClientError {
  status: number;
}

/** What a person is told for a refusal from the two factor routes; never shows the raw error. */
export function useTwoFactorMessage() {
  const { t } = useTranslation();
  return (error: ClientError | null | undefined): string | null => {
    if (!error) return null;
    if (error.status === 400) return t('account.twoFactor.wrongPassword');
    if (error.status === 429) return t('account.twoFactor.rateLimited');
    return t('account.twoFactor.failed');
  };
}
