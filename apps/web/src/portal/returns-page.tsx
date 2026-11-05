'use client';

import { useTranslation } from 'react-i18next';

/** Placeholder for the public exchange and return portal (spec 0007, section 2). */
export function ReturnsPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{t('portal.returns.title')}</h1>
      <p className="text-muted-foreground">{t('portal.returns.description')}</p>
    </div>
  );
}
