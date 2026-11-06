'use client';

import type { Home } from '@ssdashboard/contracts';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ME_PATH } from '@/auth/me-path';
import { setMe, useMe } from '@/auth/use-me';
import { loadConfig } from '@/shell/client-config';
import { PasswordSection } from './password-section';
import { ProfileSection } from './profile-section';
import { TwoFactorSection } from './two-factor-section';

/**
 * Your own account (spec 0005, AC-19, AC-25, AC-28): your details, your password and two factor
 * sign in. One component for both audiences: the back office route and the partner route render
 * it, and `audience` picks the api route it reads and saves through (`/api/me` or
 * `/api/partner/me`). Everything here is about the signed in person only.
 */
export function AccountPage({ audience = 'backoffice' }: { audience?: Home }) {
  const { t } = useTranslation();
  const me = useMe(ME_PATH[audience]);
  const [languages, setLanguages] = useState<readonly string[]>(['en']);
  const [settled, setSettled] = useState(false);
  // Set once two factor is turned on or off here, so the buttons follow without a reload.
  const [twoFactor, setTwoFactor] = useState<boolean | null>(null);

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
          <ProfileSection me={me} languages={languages} audience={audience} />
          <PasswordSection />
          <TwoFactorSection
            enabled={twoFactor ?? me.twoFactorEnabled}
            onChange={(value) => {
              setTwoFactor(value);
              setMe({ ...me, twoFactorEnabled: value });
            }}
          />
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
