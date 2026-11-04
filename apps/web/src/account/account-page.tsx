'use client';

import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/auth/use-me';
import { loadConfig } from '@/shell/client-config';
import { PasswordSection } from './password-section';
import { ProfileSection } from './profile-section';

/**
 * Your own account (spec 0005, AC-19, AC-25): your details and your password. Two factor sign in
 * joins this page in a later slice. Everything here is about the signed in person only.
 */
export function AccountPage() {
  const { t } = useTranslation();
  const me = useMe();
  const [languages, setLanguages] = useState<readonly string[]>(['en']);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let active = true;
    void loadConfig().then((config) => {
      if (!active) return;
      if (config) setLanguages(config.languages);
      setSettled(true);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex max-w-2xl min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('account.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('account.description')}</p>
      </div>

      {me && settled ? (
        <>
          <ProfileSection me={me} languages={languages} />
          <PasswordSection />
        </>
      ) : (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t('account.loading')}</span>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      )}
    </div>
  );
}
