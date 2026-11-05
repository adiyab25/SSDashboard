'use client';

import { useTranslation } from 'react-i18next';

/** Placeholder for the consignment partner area (spec 0007, section 2). */
export function PartnerPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{t('partner.home.title')}</h1>
      <p className="text-muted-foreground">{t('partner.home.description')}</p>
    </div>
  );
}
