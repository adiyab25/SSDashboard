'use client';

import { useTranslation } from 'react-i18next';

/** First focusable element on every page: jumps past the navigation to `#main-content`. */
export function SkipLink() {
  const { t } = useTranslation();

  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-input focus:bg-background focus:px-3 focus:py-2 focus:shadow-md"
    >
      {t('shell.skipLink')}
    </a>
  );
}
