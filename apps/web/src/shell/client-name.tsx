'use client';

import { useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { loadConfig } from './client-config';

/** The install's display name from `/api/config`, with the product name as fallback. */
export function ClientName({ className }: { className?: string }) {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadConfig().then((config) => {
      if (active && config) setName(config.clientName);
    });
    return () => {
      active = false;
    };
  }, []);

  return <span className={className}>{name ?? t('shell.clientNameFallback')}</span>;
}
