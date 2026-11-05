'use client';

import { Button } from '@ssdashboard/ui/components/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EnableTwoFactorDialog } from './enable-two-factor-dialog';
import { TwoFactorPasswordDialog } from './two-factor-password-dialog';

type Dialog = 'enable' | 'disable' | 'codes' | null;

/** Props of `TwoFactorSection`. */
interface Props {
  enabled: boolean;
  /** Tells the page that two factor is now on or off, so it shows the right buttons. */
  onChange: (enabled: boolean) => void;
}

/**
 * Two factor sign in on your own account (AC-20): its state, and the three things you can do
 * about it. Turning on is a short step by step dialog; the rest ask for your password.
 */
export function TwoFactorSection({ enabled, onChange }: Props) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<Dialog>(null);

  return (
    <section aria-labelledby="two-factor-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="two-factor-title" className="text-base font-semibold">
          {t('account.twoFactor.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {enabled ? t('account.twoFactor.descriptionOn') : t('account.twoFactor.descriptionOff')}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">
          {enabled ? t('account.twoFactor.statusOn') : t('account.twoFactor.statusOff')}
        </span>
        {enabled ? (
          <>
            <Button variant="outline" onClick={() => setDialog('codes')}>
              {t('account.twoFactor.newCodes')}
            </Button>
            <Button variant="outline" onClick={() => setDialog('disable')}>
              {t('account.twoFactor.disable')}
            </Button>
          </>
        ) : (
          <Button onClick={() => setDialog('enable')}>{t('account.twoFactor.enable')}</Button>
        )}
      </div>

      {dialog === 'enable' && (
        <EnableTwoFactorDialog onEnabled={() => onChange(true)} onClose={() => setDialog(null)} />
      )}
      {(dialog === 'disable' || dialog === 'codes') && (
        <TwoFactorPasswordDialog
          kind={dialog}
          onDisabled={() => onChange(false)}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
