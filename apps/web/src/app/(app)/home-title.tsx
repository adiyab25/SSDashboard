'use client';

import { useTranslation } from 'react-i18next';

export function HomeTitle() {
  const { t } = useTranslation();

  return <h1 className="text-xl font-semibold">{t('home.title')}</h1>;
}
